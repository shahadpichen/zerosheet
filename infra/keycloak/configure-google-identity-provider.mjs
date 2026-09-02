/**
 * Provision Keycloak's Google identity provider through the Admin REST API.
 *
 * Why this is a separate Node program:
 *
 * - Keycloak skips startup realm imports when the realm already exists. That is
 *   a safety feature because silently replacing a live realm could remove users
 *   and administrator changes. We therefore need an explicit, repeatable
 *   command for configuration that changes after the first startup.
 * - Node's built-in `fetch` and `URLSearchParams` let us send credentials
 *   without placing them in command-line arguments, where process-list tools
 *   could expose them.
 * - Keeping the provider representation in one object makes the intended trust
 *   policy reviewable and makes both creation and updates use identical rules.
 *
 * This program never prints the Keycloak admin password, Google client secret,
 * or short-lived Keycloak administrator token. Node loads those values from the
 * repository's ignored `.env` file before this program starts.
 */

const requiredEnvironmentVariable = (name) => {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
};

const parseBoolean = (name) => {
  const value = requiredEnvironmentVariable(name);

  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be either true or false.`);
  }

  return value === "true";
};

const keycloakUrl = requiredEnvironmentVariable("KEYCLOAK_PUBLIC_URL").replace(
  /\/$/u,
  "",
);
const realm = requiredEnvironmentVariable("KEYCLOAK_REALM");
const adminUsername = requiredEnvironmentVariable("KEYCLOAK_ADMIN_USERNAME");
const adminPassword = requiredEnvironmentVariable("KEYCLOAK_ADMIN_PASSWORD");
const googleClientId = requiredEnvironmentVariable("GOOGLE_OIDC_CLIENT_ID");
const googleClientSecret = requiredEnvironmentVariable(
  "GOOGLE_OIDC_CLIENT_SECRET",
);
const googleProviderEnabled = parseBoolean("GOOGLE_IDENTITY_PROVIDER_ENABLED");

/**
 * Placeholder values make it possible to boot and verify a local stack before
 * a developer owns a Google Cloud OAuth client. They must never be enabled:
 * doing so would advertise a login option that cannot successfully authenticate.
 */
if (
  googleProviderEnabled &&
  (googleClientId.startsWith("replace-with-") ||
    googleClientSecret.startsWith("replace-with-"))
) {
  throw new Error(
    "Replace the Google client ID and secret before enabling federation.",
  );
}

/**
 * Google is an upstream identity provider. Keycloak remains the only issuer
 * trusted by ZeroSheet, so the application does not need Google-specific token
 * validation logic.
 *
 * `storeToken` is deliberately false. Login needs identity claims, not ongoing
 * access to a user's Google APIs. A later Google Drive integration must request
 * its own consent and store its own narrowly scoped credential separately.
 *
 * The normal `first broker login` flow protects users whose local Keycloak
 * account has the same email address as a Google account. Keycloak asks the user
 * to prove control of the existing account instead of linking by email alone.
 */
const googleProvider = {
  alias: "google",
  displayName: "Google",
  providerId: "google",
  enabled: googleProviderEnabled,
  trustEmail: true,
  storeToken: false,
  addReadTokenRoleOnCreate: false,
  authenticateByDefault: false,
  linkOnly: false,
  hideOnLogin: false,
  firstBrokerLoginFlowAlias: "first broker login",
  updateProfileFirstLoginMode: "missing",
  config: {
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    defaultScope: "openid profile email",
    hostedDomain: process.env.GOOGLE_OIDC_HOSTED_DOMAIN?.trim() ?? "",
    syncMode: "IMPORT",
    useJwksUrl: "true",
  },
};

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
      username: adminUsername,
      password: adminPassword,
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

const providerCollectionUrl = `${keycloakUrl}/admin/realms/${encodeURIComponent(
  realm,
)}/identity-provider/instances`;
const existingProviderResponse = await fetch(
  `${providerCollectionUrl}/google`,
  {
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
    },
  },
);

if (
  existingProviderResponse.status !== 200 &&
  existingProviderResponse.status !== 404
) {
  throw new Error(
    `Reading the existing Google provider failed with HTTP ${existingProviderResponse.status}.`,
  );
}

const providerExists = existingProviderResponse.status === 200;
const writeResponse = await fetch(
  providerExists ? `${providerCollectionUrl}/google` : providerCollectionUrl,
  {
    method: providerExists ? "PUT" : "POST",
    headers: {
      authorization: `Bearer ${tokenPayload.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(googleProvider),
  },
);

const expectedStatus = providerExists ? 204 : 201;

if (writeResponse.status !== expectedStatus) {
  throw new Error(
    `${providerExists ? "Updating" : "Creating"} the Google provider failed with HTTP ${writeResponse.status}.`,
  );
}

console.log(
  `${providerExists ? "Updated" : "Created"} the Google identity provider (enabled=${googleProviderEnabled}).`,
);
console.log("Register this exact Google authorized redirect URI:");
console.log(`${keycloakUrl}/realms/${realm}/broker/google/endpoint`);
