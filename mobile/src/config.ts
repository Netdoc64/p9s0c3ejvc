import Constants from "expo-constants";

interface PilotConfiguration {
  apiUrl?: string;
  tenantSlug?: string;
  supportEmail?: string;
}

const manifest = (Constants.expoConfig?.extra?.pilot ?? {}) as PilotConfiguration;
export const pilotConfiguration: PilotConfiguration = {
  apiUrl: process.env.EXPO_PUBLIC_API_URL ?? manifest.apiUrl,
  tenantSlug: process.env.EXPO_PUBLIC_TENANT_SLUG ?? manifest.tenantSlug,
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? manifest.supportEmail,
};
