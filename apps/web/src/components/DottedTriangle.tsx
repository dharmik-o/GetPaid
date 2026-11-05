type Props = {
  /** Width in pixels. The height follows, at 0.9 of it. */
  size: number;
  /** Degrees. */
  rotate?: number;
  opacity?: number;
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
  /** The landing page drifts these on scroll. */
  parallax?: boolean;
  /** "ink" is black dots, for the yellow band. */
  variant?: "accent" | "ink";
};

const HEIGHT_RATIO = 0.9;

/** The brand's decoration: a triangle filled with a grid of dots, never with solid colour. */
export const DottedTriangle = ({
  size,
  rotate,
  opacity,
  top,
  right,
  bottom,
  left,
  parallax = false,
  variant = "accent",
}: Props) => (
  <div
    aria-hidden="true"
    className={variant === "ink" ? "dot-tri ink" : "dot-tri"}
    data-parallax={parallax ? "" : undefined}
    style={{
      width: size,
      height: Math.round(size * HEIGHT_RATIO),
      rotate: rotate === undefined ? undefined : `${String(rotate)}deg`,
      opacity,
      top,
      right,
      bottom,
      left,
    }}
  />
);
