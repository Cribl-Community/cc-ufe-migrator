declare global {
  interface Window {
    /** Base URL for all Cribl API calls. Includes /api/v1. E.g. https://localhost:9000/api/v1 */
    CRIBL_API_URL: string;
    /** The base path this app is mounted at. E.g. /app-ui/ufe_migrator */
    CRIBL_BASE_PATH: string;
  }
}

export {};
