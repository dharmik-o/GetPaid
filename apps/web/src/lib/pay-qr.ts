import qrcode from "qrcode-generator";

// The pay link as a QR code, made here with no network, for {{invoice.pay_qr}}. The same link always
// gives the same image, so a PDF doesn't look changed from one render to the next. Pure.

const CELL_PIXELS = 6;
const QUIET_ZONE_PIXELS = 12;

/** Empty when the link can't fit in a QR code: the link itself is still on the invoice. */
export const payQrDataUrl = (link: string): string => {
  try {
    const code = qrcode(0, "M");
    code.addData(link);
    code.make();
    return code.createDataURL(CELL_PIXELS, QUIET_ZONE_PIXELS);
  } catch {
    return "";
  }
};
