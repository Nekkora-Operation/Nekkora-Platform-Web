/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NEKKORA_SITE_URL?: string;
  readonly VITE_FEATURE_RESEND_VERIFICATION?: string;
}

/** Versão em execução, injetada pelo vite.config.ts (ver src/app/version.ts). */
declare const __NEKKORA_BUILD__: {
  webCommit: string | null;
  webBranch: string | null;
  webDirty: boolean;
  apiCommit: string | null;
  lib: string | null;
};
