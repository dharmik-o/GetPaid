// WCAG contrast from any colour the CSS or a browser reports: #rrggbb, or rgb()/rgba().

export type Rgba = { r: number; g: number; b: number; a: number };

export const parseColor = (text: string): Rgba => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text.trim());
  if (hex) {
    const [r, g, b] = hex.slice(1).map((part) => parseInt(part, 16)) as [number, number, number];
    return { r, g, b, a: 1 };
  }
  const rgb = /^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/.exec(
    text.trim(),
  );
  if (!rgb) throw new Error(`Couldn't read the colour "${text}". Use #rrggbb or rgb().`);
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
};

const channel = (value: number): number => {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
};

const luminance = ({ r, g, b }: Rgba): number =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export const contrast = (first: string, second: string): number => {
  const a = luminance(parseColor(first));
  const b = luminance(parseColor(second));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
