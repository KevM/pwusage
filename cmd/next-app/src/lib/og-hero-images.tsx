/* eslint-disable @next/next/no-img-element -- ImageResponse (Satori) renders plain <img>; next/image does not apply */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { HERO_IMAGE_SIZE } from './social-metadata';

/**
 * 1200×630 link-preview hero images, built from the screenshots the pages already show so the
 * card previews the page instead of repeating its title. No text in the images: the card's
 * title and description sit right beside them.
 */

function publicPng(path: string): string {
    const data = readFileSync(join(process.cwd(), 'public', path));
    return `data:image/png;base64,${data.toString('base64')}`;
}

/** The sign-in page's dashboard summary (930×375), on the light page background. */
export function homeHeroImage(): ImageResponse {
    const width = 1100;
    const height = Math.round((width * 375) / 930);
    return new ImageResponse(
        (
            <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6' }}>
                <img
                    src={publicPng('login-summary-v2.png')}
                    width={width}
                    height={height}
                    alt=""
                    style={{ borderRadius: 16, border: '1px solid #d1d5db', boxShadow: '0 12px 32px rgba(17, 24, 39, 0.12)' }}
                />
            </div>
        ),
        HERO_IMAGE_SIZE
    );
}

const PHONE_SCREENS = ['ios/home.png', 'ios/bill.png', 'ios/smart-shift.png'] as const;

/** The iPhone Home, Bill and Smart Shift screens (660×1434) in phone frames. */
export function iosHeroImage(): ImageResponse {
    const screenHeight = 540;
    const screenWidth = Math.round((screenHeight * 660) / 1434);
    return new ImageResponse(
        (
            <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', gap: 48, background: '#111827' }}>
                {PHONE_SCREENS.map((path) => (
                    <div key={path} style={{ display: 'flex', padding: 8, borderRadius: 44, background: '#000', border: '2px solid #374151' }}>
                        <img src={publicPng(path)} width={screenWidth} height={screenHeight} alt="" style={{ borderRadius: 36 }} />
                    </div>
                ))}
            </div>
        ),
        HERO_IMAGE_SIZE
    );
}

/** The demo TRMNL screen (800×480, rendered from the real plugin markup) in a device bezel. */
export function trmnlHeroImage(): ImageResponse {
    const screenWidth = 760;
    const screenHeight = Math.round((screenWidth * 480) / 800);
    return new ImageResponse(
        (
            <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', background: '#e5e7eb' }}>
                <div style={{ display: 'flex', padding: 28, borderRadius: 28, background: '#4b5563', boxShadow: '0 16px 40px rgba(17, 24, 39, 0.25)' }}>
                    <img src={publicPng('social/trmnl-demo.png')} width={screenWidth} height={screenHeight} alt="" style={{ borderRadius: 6 }} />
                </div>
            </div>
        ),
        HERO_IMAGE_SIZE
    );
}
