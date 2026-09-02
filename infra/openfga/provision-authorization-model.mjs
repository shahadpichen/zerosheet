import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Provision the versioned ZeroSheet authorization model into OpenFGA.
 *
 * The friendly DSL arrives on stdin after the official OpenFGA CLI validates
 * and transforms it into the API JSON representation. This program finds or
 * creates one named store, avoids writing duplicate model versions, and emits
 * a local ignored environment file containing the generated immutable IDs.
 *
 * The API key is loaded from `.env` and is never printed or written to the
 * generated state file.
 */

const requiredEnvironmentVariable = (name) => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

let transformedModelText = "";

for await (const chunk of process.stdin) {
  transformedModelText += chunk;
}

if (!transformedModelText.trim()) {
  throw new Error("The OpenFGA CLI produced no transformed model JSON.");
}

const transformedModel = JSON.parse(transformedModelText);

if (
  transformedModel.schema_version !== "1.1" ||
  !Array.isArray(transformedModel.type_definitions)
) {
  throw new Error("The transformed OpenFGA model has an unexpected shape.");
}

const apiUrl = requiredEnvironmentVariable("OPENFGA_API_URL").replace(
  /\/$/u,
  "",
);
const apiToken = requiredEnvironmentVariable("OPENFGA_PRESHARED_KEY");
const storeName = requiredEnvironmentVariable("OPENFGA_STORE_NAME");

/**
 * Provisioning uses Node's built-in fetch because this script lives outside an
 * application package. The running API uses the official SDK for retries and
 * typed requests; this small administrative client needs only four supported
 * REST operations and avoids duplicating a workspace dependency at the root.
 */
const openFgaRequest = async (path, init = {}) => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(
      `OpenFGA ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}.`,
    );
  }

  return response.status === 204 ? undefined : response.json();
};

const storeQuery = new URLSearchParams({ name: storeName, page_size: "100" });
const storesResponse = await openFgaRequest(`/stores?${storeQuery}`);
const matchingStores = (storesResponse.stores ?? []).filter(
  (store) => store.name === storeName,
);

if (matchingStores.length > 1) {
  throw new Error(
    `More than one OpenFGA store is named ${storeName}; refusing to choose an authorization boundary implicitly.`,
  );
}

const store =
  matchingStores[0] ??
  (await openFgaRequest("/stores", {
    method: "POST",
    body: JSON.stringify({ name: storeName }),
  }));

if (!store?.id) {
  throw new Error("OpenFGA did not return a store ID.");
}

const storePath = `/stores/${encodeURIComponent(store.id)}`;
const modelsResponse = await openFgaRequest(
  `${storePath}/authorization-models?page_size=1`,
);

/**
 * OpenFGA model versions are immutable. Canonical comparison lets repeated
 * provisioning reuse the current version while a genuine policy change writes
 * a new auditable version. The server-added model ID is excluded from content
 * comparison because it is metadata rather than authorization logic.
 */
const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

/**
 * OpenFGA expands omitted protobuf defaults when a model is read back: empty
 * strings appear on computed usersets, empty arrays appear on relation
 * metadata, and null source information is added. These values do not change
 * authorization behavior. Normalizing both representations prevents a repeat
 * provision from creating a new immutable model version for serialization-only
 * differences.
 */
const normalizeRewrite = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalizeRewrite);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, entry]) => !(key === "object" && entry === ""))
        .map(([key, entry]) => [key, normalizeRewrite(entry)]),
    );
  }

  return value;
};

const normalizeRelationMetadata = (metadata = {}) => {
  const relatedTypes = metadata.directly_related_user_types ?? [];

  if (relatedTypes.length === 0) {
    return {};
  }

  return {
    directly_related_user_types: relatedTypes.map((relatedType) => ({
      type: relatedType.type,
      ...(relatedType.relation ? { relation: relatedType.relation } : {}),
      ...(relatedType.condition ? { condition: relatedType.condition } : {}),
    })),
  };
};

const normalizeModel = (model) => ({
  schema_version: model.schema_version,
  type_definitions: model.type_definitions.map((definition) => ({
    type: definition.type,
    ...(definition.relations && Object.keys(definition.relations).length > 0
      ? { relations: normalizeRewrite(definition.relations) }
      : {}),
    ...(definition.metadata
      ? {
          metadata: {
            relations: Object.fromEntries(
              Object.entries(definition.metadata.relations ?? {}).map(
                ([relation, metadata]) => [
                  relation,
                  normalizeRelationMetadata(metadata),
                ],
              ),
            ),
          },
        }
      : {}),
  })),
  ...(model.conditions && Object.keys(model.conditions).length > 0
    ? { conditions: normalizeRewrite(model.conditions) }
    : {}),
});

const latestModel = modelsResponse.authorization_models?.[0];
let authorizationModelId;

if (latestModel) {
  const { id, ...latestModelContent } = latestModel;

  if (
    canonicalJson(normalizeModel(latestModelContent)) ===
    canonicalJson(normalizeModel(transformedModel))
  ) {
    authorizationModelId = id;
  }
}

if (!authorizationModelId) {
  const writeResponse = await openFgaRequest(
    `${storePath}/authorization-models`,
    {
      method: "POST",
      body: JSON.stringify(transformedModel),
    },
  );
  authorizationModelId = writeResponse.authorization_model_id;
}

if (!authorizationModelId) {
  throw new Error("OpenFGA did not return an authorization model ID.");
}

const generatedEnvironmentPath = resolve(process.cwd(), ".env.openfga");
const generatedEnvironment = `# Generated by pnpm infra:authorization:provision.
#
# These are non-secret identifiers, but the file is machine-local because each
# OpenFGA database creates different immutable IDs. Do not edit it manually.
OPENFGA_STORE_ID=${store.id}
OPENFGA_AUTHORIZATION_MODEL_ID=${authorizationModelId}
`;

await writeFile(generatedEnvironmentPath, generatedEnvironment, {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(generatedEnvironmentPath, 0o600);

console.log(`OpenFGA store: ${store.id}`);
console.log(`Authorization model: ${authorizationModelId}`);
console.log(`Wrote local runtime identifiers to ${generatedEnvironmentPath}.`);
