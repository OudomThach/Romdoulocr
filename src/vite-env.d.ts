/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_METADATA_URL?: string;
  readonly VITE_METADATA_PIPELINE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
