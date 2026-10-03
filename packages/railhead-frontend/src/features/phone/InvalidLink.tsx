import { Empty } from "@cloudflare/kumo";
import { LinkBreakIcon } from "@phosphor-icons/react";

/** A link whose parameter is missing or malformed. It shows nothing from the board. */
export const InvalidLink = () => (
  <div className="mx-auto grid w-full max-w-xl px-4 py-4">
    <Empty
      icon={<LinkBreakIcon size={48} aria-hidden="true" />}
      title="This link is not valid"
      description="It does not name anything on this board. Scan the code on the board again."
    />
  </div>
);
