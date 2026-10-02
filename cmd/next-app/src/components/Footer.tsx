import Link from 'next/link';

export function Footer() {
    return (
        <footer className="py-12 mt-auto" style={{ backgroundColor: '#111827', color: '#d1d5db' }}>
            <div className="container mx-auto px-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {/* SEO Text Section */}
                    <div>
                        <h3 className="text-white text-lg font-bold mb-4">About Powerwall Usage</h3>
                        <p className="leading-relaxed text-sm">
                            We use the data from your Tesla Powerwall gateway to assist in monitoring your electricity consumption.
                            This helps you make smart decisions about when best to use energy in your home to save money using energy arbitrage.
                        </p>
                    </div>

                    {/* Links Section */}
                    <div className="flex flex-col md:items-end space-y-2">
                        <h3 className="text-white text-lg font-bold mb-2">Quick Links</h3>
                        <Link href="/about" className="hover:text-white transition-colors">
                            About
                        </Link>
                        <Link href="/support" className="hover:text-white transition-colors">
                            Support
                        </Link>
                        <Link href="/privacy" className="hover:text-white transition-colors">
                            Privacy Policy
                        </Link>
                        <a href="https://discord.gg/KCweVtVNAB" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors">
                            Discord
                        </a>
                    </div>
                </div>

                <div className="border-t border-gray-800 mt-8 pt-8 text-center text-sm" style={{ color: '#6b7280' }}>
                    &copy; {new Date().getFullYear()} Powerwall Usage. All rights reserved.
                    {process.env.VERCEL_GIT_COMMIT_SHA && (
                        <span className="ml-4 font-mono text-xs opacity-50">
                            v:{process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 7)}
                        </span>
                    )}
                </div>
            </div>
        </footer>
    );
}
