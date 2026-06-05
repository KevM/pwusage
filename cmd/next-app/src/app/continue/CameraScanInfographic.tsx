import Image from 'next/image';

/**
 * Static infographic for the /continue page showing how to re-scan with the
 * iPhone Camera app: swipe up to the Home screen, tap the Camera app, then point
 * it at the QR code. Presentational only so it renders in the server-rendered
 * ContinuePage.
 *
 * Asset lives at public/camera-scan-steps.png.
 */
export function CameraScanInfographic() {
  return (
    <figure className="mx-auto w-full max-w-sm overflow-hidden rounded-lg border border-gray-200 bg-white p-2">
      <Image
        src="/camera-scan-steps.png"
        alt="Three steps on an iPhone: swipe up to the Home screen, tap the Camera app, then point it at the QR code to scan."
        width={1301}
        height={502}
        className="h-auto w-full"
        priority={false}
      />
    </figure>
  );
}
