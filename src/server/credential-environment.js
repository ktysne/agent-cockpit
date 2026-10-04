'use strict';

const GITHUB_CREDENTIAL_ENVIRONMENT_VARIABLES = Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']);
const githubCredentialEnvironmentVariables = new Set(GITHUB_CREDENTIAL_ENVIRONMENT_VARIABLES);

function isGithubCredentialEnvironmentVariable(name) {
  return typeof name === 'string' && githubCredentialEnvironmentVariables.has(name.toUpperCase());
}

module.exports = { GITHUB_CREDENTIAL_ENVIRONMENT_VARIABLES, isGithubCredentialEnvironmentVariable };
