/// <reference types="vite/client" />
import type { CabooseApi } from "../../shared/types.ts";

declare global {
  interface Window {
    caboose: CabooseApi;
  }
}
