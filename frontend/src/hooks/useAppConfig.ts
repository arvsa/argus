import { useQuery } from "@tanstack/react-query";
import { getAppConfig, type DeploymentRole } from "@/api/appConfig";

export interface UseAppConfigResult {
  role: DeploymentRole;
  isLoaded: boolean;
}

// Which deployment role this frontend is talking to. One fetch per session
// (the role can't change without redeploying the backend). Defaults to
// "client" -- same default as the backend's ROLE setting -- so a
// single-stack deployment behaves identically even if the probe fails;
// callers that must not flash the wrong UI first should gate on isLoaded.
export function useAppConfig(): UseAppConfigResult {
  const { data, isSuccess, isError } = useQuery({
    queryKey: ["app-config"],
    queryFn: getAppConfig,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
  return { role: data?.role ?? "client", isLoaded: isSuccess || isError };
}
