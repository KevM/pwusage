import { cookies } from 'next/headers';
import Link from 'next/link';
import { TeslaClient } from '@/lib/tesla-client';

export default async function Home() {
  const cookieStore = await cookies();
  const token = cookieStore.get('access_token')?.value;

  if (!token) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-24">
        <h1 className="text-4xl font-bold mb-8">Powerwall Usage</h1>
        <Link
          href="/login"
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Login with Tesla
        </Link>
      </div>
    );
  }

  try {
    const client = new TeslaClient(token);
    const products = await client.getProducts();

    return (
      <div className="flex min-h-screen flex-col items-center p-24">
        <div className="w-full max-w-4xl">
          <div className="flex justify-between items-center mb-8">
            <h1 className="text-4xl font-bold">Dashboard</h1>
            <Link href="/settings" className="text-blue-600 hover:underline">Settings</Link>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {products.map((product) => (
              <div key={product.id} className="border p-4 rounded shadow hover:shadow-lg transition">
                <h2 className="text-xl font-semibold">{product.site_name}</h2>
                <p className="text-gray-600">Site ID: {product.energy_site_id}</p>
                <p className="text-gray-600">Battery: {product.battery_power} kW</p>
                <p className="text-gray-600">Percentage: {product.percentage_charged}%</p>
                <div className="mt-4">
                  <Link href={`/site/${product.energy_site_id}`} className="text-blue-600 hover:underline">
                    View Details
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  } catch (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-24">
        <h1 className="text-4xl font-bold mb-8">Error</h1>
        <p className="text-red-500 mb-4">Failed to load products. Your session may have expired.</p>
        <p className="text-gray-500 mb-4">{(error as Error).message}</p>
        <Link
          href="/login"
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
        >
          Re-Login
        </Link>
      </div>
    );
  }
}
