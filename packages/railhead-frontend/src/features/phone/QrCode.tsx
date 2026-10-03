import { encode } from "uqr";

interface QrCodeProps {
  /** The text to encode, a link built by `phoneLinks`. */
  value: string;
  /** What scanning the code opens, for people who cannot see it. */
  label: string;
}

/** Quiet zone around the code, in modules. The QR specification asks for four. */
const QUIET_ZONE = 4;

/**
 * A QR code drawn as SVG paths from the encoded module matrix, dark on light whatever the theme,
 * since phone cameras read light-on-dark codes unreliably. `M` error correction tolerates a glare
 * spot on a laptop screen without growing past what a phone resolves at arm's length.
 */
export const QrCode = ({ value, label }: QrCodeProps) => {
  const { data, size } = encode(value, { ecc: "M", border: QUIET_ZONE });
  const dark = data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : [])));
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      className="aspect-square w-full max-w-48"
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="white" />
      <path d={dark.join("")} fill="black" />
    </svg>
  );
};
