/**
 * Read Keycloak's persisted Google broker configuration and assert the security
 * decisions ZeroSheet depends on.
 *
 * Docker health alone cannot prove that federation is configured correctly.
 * This verifier uses Keycloak's supported Admin REST API and checks the stored
 * representation without ever printing the Google client secret or the
 * short-lived administrator access token.
 */

const requiredEnvironmentVariable = (name) => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const keycloakUrl = requiredEnvironmentVariable("KEYCLOAK_PUBLIC_URL").replace(
  /\/$/u,
  "",
);
const realm = requiredEnvironmentVariable("KEYCLOAK_REALM");
const expectedEnabled = requiredEnvironmentVariable(
  "GOOGLE_IDENTITY_PROVIDER_ENABLED",
);

if (expectedEnabled !== "true" && expectedEnabled !== "false") {
  throw new Error(
    "GOOGLE_IDENTITY_PROVIDER_ENABLED must be either true or false.",
  );
}

const tokenResponse = await fetch(
  `${keycloakUrl}/realms/master/protocol/openid-connect/token`,
  {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: "admin-cli",
      grant_type: "password",
      username: requiredEnvironmentVariable("KEYCLOAK_ADMIN_USERNAME"),
      password: requiredEnvironmentVariable("KEYCLOAK_ADMIN_PASSWORD"),
    }),
  },
);

if (!tokenResponse.ok) {
  throw new Error(
    `Keycloak administrator authentication failed with HTTP ${tokenResponse.status}.`,
  );
}

const tokenPayload = await tokenResponse.json();

if (typeof tokenPayload.access_token !== "string") {
  throw new Error("Keycloak did not return an administrator access token.");
}

const providerResponse = await fetch(
  `${keycloakUrl}/admin/realms/${encodeURIComponent(
    realm,
  )}/identity-provider/instances/google`,
  {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
    },
  },
);

if (!providerResponse.ok) {
  throw new Error(
    `Reading the Google identity provider failed with HTTP ${providerResponse.status}.`,
  );
}

const provider = await providerResponse.json();

/**
 * Keycloak's representation mixes real booleans at the top level with string
 * values inside `config`. Comparing an explicit set documents that distinction
 * and fails when an upgrade or manual console edit weakens the intended policy.
 */
const expectedProviderValues = new Map([
  ["alias", "google"],
  ["providerId", "google"],
  ["enabled", expectedEnabled === "true"],
  ["trustEmail", true],
  ["storeToken", false],
  ["linkOnly", false],
  ["firstBrokerLoginFlowAlias", "first broker login"],
  ["config.clientId", requiredEnvironmentVariable("GOOGLE_OIDC_CLIENT_ID")],
  ["config.defaultScope", "openid profile email"],
  ["config.syncMode", "IMPORT"],
  ["config.useJwksUrl", "true"],
]);

const valueAtPath = (object, path) =>
  path.split(".").reduce((value, segment) => value?.[segment], object);

for (const [path, expected] of expectedProviderValues) {
  const actual = valueAtPath(provider, path);

  if (actual !== expected) {
    throw new Error(
      `Google provider setting ${path} was ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}.`,
    );
  }
}

/**
 * We only assert that Keycloak retained a secret value. We never compare it in
 * an error message because that could copy a real Google credential into CI or
 * terminal logs. Keycloak normally masks this field in Admin API responses.
 */
if (
  typeof provider.config?.clientSecret !== "string" ||
  provider.config.clientSecret.length === 0
) {
  throw new Error("Keycloak did not retain a Google client secret value.");
}

console.log(
  "PASS: Keycloak persists one Google broker with minimal login scopes, protected first-login linking, and no upstream token storage.",
);
