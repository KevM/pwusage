import { redirect } from 'next/navigation';
import { isUserAdmin } from '@/lib/auth-checks';
import { UserRepo } from '@/lib/user-repo';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        redirect('/'); // Or show unauthorized message
    }

    const userRepo = new UserRepo();
    const users = await userRepo.getAllUsers();

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <h1 className="text-3xl font-bold mb-8">Admin Dashboard</h1>

            <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-900">
                        <tr>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                User ID / Email
                            </th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                Created At
                            </th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                Roles
                            </th>
                            <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                                Sites
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                        {users.map((user) => (
                            <tr key={user.id}>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                                        {user.email || 'No Email'}
                                    </div>
                                    <div className="text-sm text-gray-500 dark:text-gray-400">
                                        {user.id}
                                    </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                    {user.created_at ? new Date(Number(user.created_at)).toLocaleDateString() : 'N/A'}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                                    {user.roles && user.roles.length > 0 ? (
                                        <div className="flex gap-1">
                                            {user.roles.map(role => (
                                                <span key={role} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                                                    {role}
                                                </span>
                                            ))}
                                        </div>
                                    ) : (
                                        <span className="text-gray-400">User</span>
                                    )}
                                </td>
                                <td className="px-6 py-4">
                                    <div className="flex flex-col gap-2">
                                        {user.sites.length > 0 ? (
                                            user.sites.map(site => (
                                                <div key={site.id} className="text-sm">
                                                    <Link
                                                        href={`/site/${site.id}`}
                                                        className="text-indigo-600 hover:text-indigo-900 dark:text-indigo-400 dark:hover:text-indigo-300 font-medium"
                                                    >
                                                        {site.name} ({site.id})
                                                    </Link>
                                                    <div className="text-xs text-gray-500">
                                                        Last Update: {new Date(site.updated).toLocaleString()}
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <span className="text-sm text-gray-400 italic">No Sites</span>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
