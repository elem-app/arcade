/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ARCADE_WEB_FIXTURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
