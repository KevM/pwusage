import { ImageResponse } from 'next/og'

// Route segment config
export const runtime = 'edge'

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
    const iconData = await fetch(new URL('./icon.png', import.meta.url)).then((res) =>
        res.arrayBuffer()
    )

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
                    // @ts-ignore
                    src={iconData}
                    width="200"
                    height="200"
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
