/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FAKE_UPDATE_AVAILABLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
