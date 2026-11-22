import type { Tracker } from "./contracts.ts";
import type { ReadOperation } from "./discovery.ts";

export async function ensureRepositoryLabel(
  tracker: Tracker,
  read: ReadOperation,
  repository: string,
  label: string,
  kind: "maintenance" | "reservation",
): Promise<void> {
  const retry = kind === "reservation" ? "never" : "automatic";
  const labelExists = async () => {
    let page: number | null = 1;
    const visited = new Set<number>();
    while (page !== null) {
      if (visited.has(page)) throw new Error(`Repeated ${kind} label page`);
      visited.add(page);
      const current: number = page;
      const result: Awaited<ReturnType<Tracker["listLabelsPage"]>> = await read(
        `read_${kind}_labels`,
        `page:${page}`,
        () => tracker.listLabelsPage(repository, current),
        { retry },
      );
      if (result.labels.includes(label)) return true;
      page = result.nextPage;
    }
    return false;
  };
  if (!(await labelExists()))
    await read(
      `create_${kind}_label`,
      label,
      () => tracker.createLabel(repository, label),
      {
        retry,
        reconcile: async () =>
          (await labelExists())
            ? { outcome: "completed", result: undefined }
            : { outcome: "pending" },
      },
    );
}
