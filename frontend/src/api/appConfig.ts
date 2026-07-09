import client from "./client";

export type DeploymentRole = "client" | "server";

export interface AppConfig {
  role: DeploymentRole;
}

export const getAppConfig = async () => {
  const res = await client.get<AppConfig>("/utils/app-config");
  return res.data;
};
