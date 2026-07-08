import { z } from "zod";

export const loginSchema = z.object({
  username: z.email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export const registerSchema = z.object({
  email: z.email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().optional(),
});

export const forgotPasswordSchema = z.object({
  email: z.email("Invalid email"),
});

export const resetPasswordSchema = z
  .object({
    new_password: z.string().min(8, "Password must be at least 8 characters"),
    confirm_password: z.string(),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
  });

export const changePasswordSchema = z
  .object({
    current_password: z.string().min(1, "Current password is required"),
    new_password: z.string().min(8, "Must be at least 8 characters"),
    confirm_password: z.string(),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
  });

export const updateMeSchema = z.object({
  full_name: z.string().optional(),
  email: z.email("Invalid email").optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
