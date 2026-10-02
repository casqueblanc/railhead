import type { CommitSha } from "@railhead/shared/events";

/** A commit id shortened to 7 characters; hovering shows the full id. */
export const ShortSha = ({ sha }: { sha: CommitSha }) => (
  <span className="font-mono text-[0.9em]" translate="no" title={sha}>
    {sha.slice(0, 7)}
  </span>
);
