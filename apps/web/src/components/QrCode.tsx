import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Renders `text` as a QR code (SVG data URI; dark modules on white for reliable scanning). */
export function QrCode({
  text,
  size = 200,
  label,
}: {
  text: string;
  size?: number;
  label: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(text, { type: "svg", margin: 2, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (alive) setSrc(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
      })
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [text]);
  if (!src) return <div style={{ width: size, height: size }} aria-hidden />;
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={label}
      className="rounded-md bg-white"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
