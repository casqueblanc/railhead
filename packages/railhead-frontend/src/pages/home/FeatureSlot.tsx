import { LayerCard, Text } from "@cloudflare/kumo";
import { createElement, useId } from "react";
import type { FeatureEntry } from "../../features/board/boardPorts";

interface FeatureSlotProps<Props extends object> {
  entry: FeatureEntry<Props>;
  /** What the feature's component receives. */
  props: Props;
  /** The section's heading while the feature is unavailable. */
  title: string;
  /** What the person cannot do here while the feature is unavailable. */
  unavailable: string;
}

/** One leaf feature's place on the board: its component, or a section saying it is unavailable. */
export const FeatureSlot = <Props extends object>({
  entry,
  props,
  title,
  unavailable,
}: FeatureSlotProps<Props>) => {
  const headingId = useId();
  if (entry.kind === "available") return createElement(entry.Component, props);
  return (
    <section aria-labelledby={headingId}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading">
            <span id={headingId}>{title}</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="px-4 py-3">
          <Text variant="secondary">Not available. {unavailable}</Text>
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};
