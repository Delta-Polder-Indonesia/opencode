interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../../opencode/src/node").Server.listen
    export type Listener = import("../../../../opencode/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../../opencode/src/node").Config.get
    export type Info = import("../../../../opencode/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../../opencode/src/node").bootstrap
}
