import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ImageResponse } from 'next/og'

// Route segment config
export const runtime = 'nodejs'

// Image metadata
export const alt = 'Powerwall Usage'
export const size = {
    width: 1200,
    height: 630,
}

export const contentType = 'image/png'

// Image generation
export default async function Image() {
    // Font loading (optional, using system sans-serif for now for speed/simplicity)

    // Load the icon
    const iconPath = join(process.cwd(), 'src/app/icon.png')
    const iconBuffer = readFileSync(iconPath)
    const iconData = iconBuffer.buffer.slice(iconBuffer.byteOffset, iconBuffer.byteOffset + iconBuffer.byteLength)

    return new ImageResponse(
        (
            // ImageResponse JSX element
            <div
                style={{
                    background: '#111827', // Tailwind gray-900 matches footer/theme
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'sans-serif',
                }}
            >
                {/* Icon */}
                <img
                    // @ts-expect-error - ImageResponse supports buffer as src
                    src={iconData}
                    alt="Powerwall Usage Icon"
                    width={200}
                    height={200}
                    style={{
                        borderRadius: '20px', // Optional: rounded corners for icon
                        marginBottom: 40
                    }}
                />

                {/* Title */}
                <div style={{ fontSize: 80, fontWeight: 'bold', color: 'white', letterSpacing: '-0.025em' }}>
                    Powerwall Usage
                </div>

                {/* Tagline */}
                <div style={{ fontSize: 40, marginTop: 20, color: '#9ca3af' }}>
                    Powerwall insights for smarter energy savings.
                </div>
            </div>
        ),
        // ImageResponse options
        {
            ...size,
        }
    )
}
