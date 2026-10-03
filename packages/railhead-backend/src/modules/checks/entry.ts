// Checks: trusted check runs on exact candidates, implemented by `createChecks` in `src/checks/`.
// The definition is read from main through the Worker's Artifacts binding, each run is a `CHECKS`
// Workflow instance in a sandbox slot the sandbox module admitted, and its report comes back
// through `Repo.reportCheck`. Without a valid `CLOUDFLARE_ACCOUNT_ID`, `definitions` and `start`
// refuse with `unavailable` and nothing runs, so nothing passes.

import type { CommitSha } from "@railhead/shared/events";
import { mainRepoName } from "../../artifacts/adapter";
import { AttemptTable } from "../../checks/attempts";
import { createChecks, type MainReader, type MainSource } from "../../checks/port";
import type { CheckRunParams } from "../../checks/workflow";
import type { CheckPort } from "../../contracts/train";
import type { ModuleFactory } from "../../repo/composeRepo";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** Builds the checks module of one repository. */
export const checks: ModuleFactory<CheckPort> = (context, ports) =>
  createChecks({
    repoId: context.repoId,
    attempts: new AttemptTable(context.storage),
    main: async (): Promise<MainSource | null> => {
      const account: unknown = context.env.CLOUDFLARE_ACCOUNT_ID;
      if (typeof account !== "string" || !ACCOUNT_ID.test(account)) return null;
      const name = await mainRepoName(context.repoId);
      return {
        name,
        namespace: context.env.ARTIFACTS_NAMESPACE,
        host: `${account}.artifacts.cloudflare.net`,
        reader: artifactsReader(context.env.ARTIFACTS, name),
      };
    },
    runs: {
      // `createBatch` skips an instance that already exists, so a repeat starts nothing new.
      create: async (id: string, params: CheckRunParams) => {
        await context.env.CHECKS.createBatch([{ id, params }]);
      },
    },
    clock: context.clock,
    ports,
  });

/** Reads one Artifacts repository's objects through the Worker's binding. */
export function artifactsReader(artifacts: Artifacts, name: string): MainReader {
  return {
    async readFile(commit: CommitSha, path: string, maxBytes: number) {
      using repo = await artifacts.get(name);
      const blob = await repo.readFile({ ref: commit, path });
      if (blob === null) return null;
      // One byte past the limit is enough for the parser to refuse the file as too large.
      return new Uint8Array(await blob.slice(0, maxBytes + 1).arrayBuffer());
    },
    async rootTree(commit: CommitSha) {
      using repo = await artifacts.get(name);
      return (await repo.readCommit(commit))?.treeHash ?? null;
    },
    async readTree(hash: string) {
      using repo = await artifacts.get(name);
      const entries = await repo.readTree(hash);
      return (
        entries?.map(({ name: entry, hash: object, type }) => ({
          name: entry,
          hash: object,
          type,
        })) ?? null
      );
    },
  };
}
