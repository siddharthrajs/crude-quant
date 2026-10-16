import { AccountSettingsCard } from "@/components/settings/account-settings-card"
import { AddUserCard } from "@/components/settings/add-user-card"
import { ManageUsersCard } from "@/components/settings/manage-users-card"
import { ProfileCard } from "@/components/settings/profile-card"
import { useAuth } from "@/hooks/use-auth"

export function SettingsTab() {
  const { user } = useAuth()

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      <div className="flex flex-wrap items-start gap-6">
        <ProfileCard />
        <AccountSettingsCard />
        {user?.is_superuser && <AddUserCard />}
        {user?.is_superuser && <ManageUsersCard />}
      </div>
    </div>
  )
}
