import type { ViewerIdentity } from "./contracts.ts";

export interface ViewerLookup {
  read(): Promise<ViewerIdentity>;
  seed(viewer: ViewerIdentity | null): void;
}

export function viewerOf(context: { viewer?: ViewerLookup }): ViewerLookup {
  if (!context.viewer) throw new Error("viewer identity is unavailable");
  return context.viewer;
}

export function cachedViewer(
  load: () => Promise<ViewerIdentity>,
): ViewerLookup {
  let identity: ViewerIdentity | undefined;
  let pending: Promise<ViewerIdentity> | undefined;
  return {
    seed(viewer) {
      if (viewer && !identity) identity = viewer;
    },
    read() {
      if (identity) return Promise.resolve(identity);
      pending ??= load()
        .then(
          (viewer) => {
            identity ??= viewer;
            return identity;
          },
          (error: unknown) => {
            if (!identity) throw error;
            return identity;
          },
        )
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}
