
import { redirect } from 'next/navigation';
import { isUserAdmin } from '@/lib/auth-checks';
import { UserRepo } from '@/lib/user-repo';
import { AdminDashboard } from './AdminDashboard';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        redirect('/'); // Or show unauthorized message
    }

    const userRepo = new UserRepo();
    // Assuming getAllUsers returns something compatible with the interface defined in AdminDashboard
    // If not, we might need to map it, but it looked compatible from the previous read.
    const users = await userRepo.getAllUsers();

    return (
        <AdminDashboard users={users} />
    );
}
