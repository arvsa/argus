import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";

interface Crumb {
  label: string;
  to?: string;
}

export function HierarchyBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav className="flex items-center gap-1 text-sm text-gray-500">
      {crumbs.map((crumb, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-4 w-4 text-gray-300" />}
          {crumb.to ? (
            <Link to={crumb.to} className="hover:text-blue-600 hover:underline underline-offset-2">
              {crumb.label}
            </Link>
          ) : (
            <span className="font-medium text-gray-800">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
