export type ServerConfig = {
  readonly googleCloudQuotaProject: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const googleCloudQuotaProject = env.GOOGLE_CLOUD_QUOTA_PROJECT?.trim() ?? '';
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(googleCloudQuotaProject)) {
    throw new Error(`GOOGLE_CLOUD_QUOTA_PROJECT must be a Google Cloud project ID (received ${JSON.stringify(env.GOOGLE_CLOUD_QUOTA_PROJECT)})`);
  }
  return { googleCloudQuotaProject };
}
