module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    pilot: {
      apiUrl: process.env.EXPO_PUBLIC_API_URL?.trim() || undefined,
      tenantSlug: process.env.EXPO_PUBLIC_TENANT_SLUG?.trim() || "pilot",
      supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL?.trim() || undefined,
    },
  },
});
