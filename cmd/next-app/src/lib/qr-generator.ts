import QRCode from 'qrcode';

/**
 * Draws a QR code onto a canvas with a custom logo centered in the middle.
 * Uses high error correction level ('H') to ensure the QR code remains scannable.
 */
export async function drawQrWithLogo(
  canvas: HTMLCanvasElement,
  url: string,
  logoUrl: string = '/apple-touch-icon.png',
  logoSize: number = 44
): Promise<void> {
  // Render the base QR code on the canvas.
  // We use errorCorrectionLevel: 'H' (High - 30% restoration capacity)
  // because we are placing a logo in the center which blocks some data points.
  await QRCode.toCanvas(canvas, url, {
    width: 256,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: {
      dark: '#000000',
      light: '#ffffff'
    }
  });

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Load the logo image
  const img = new Image();
  img.src = logoUrl;
  
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });

  // Calculate coordinates to center the logo
  const x = (canvas.width - logoSize) / 2;
  const y = (canvas.height - logoSize) / 2;

  // Draw a white circular backdrop behind the logo to clear the QR modules
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(canvas.width / 2, canvas.height / 2, logoSize / 2 + 4, 0, Math.PI * 2);
  ctx.fill();

  // Draw the logo image in the center
  ctx.drawImage(img, x, y, logoSize, logoSize);
}
