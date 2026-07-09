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

// First root-level NodeType for a tenant that has none yet -- rank 0 and no
// parent_type_id are implied, not user-editable (see plan/frontend-v2.md
// Phase 2a: the API only allows appending to a rank chain, never inserting).
export const firstNodeTypeSchema = z.object({
  tenant_id: z.string().min(1, "Tenant ID is required"),
  name: z.string().min(1, "Name is required"),
});

// A new rank appended to the end of an already-seeded chain -- tenant_id,
// rank, and parent_type_id are all derived from the existing chain.
export const appendNodeTypeSchema = z.object({
  name: z.string().min(1, "Name is required"),
});

export const renameNodeTypeSchema = z.object({
  name: z.string().min(1, "Name is required"),
});

// Node create/rename share the same shape as NodeType's -- name is the
// only user-editable field on either (see backend/app/models.py's
// NodeUpdate doc comment: node_type_id/parent_id are structural).
export const nodeNameSchema = z.object({
  name: z.string().min(1, "Name is required"),
});

export const deviceAssignmentSchema = z.object({
  addr: z.string().min(1, "Address is required"),
});

// Node creation additionally needs the NodeType to create it as -- see
// NodeTree.tsx's NodeCreateForm, which only renders the field when there's
// more than one candidate type for the position (root vs. child of a
// given parent).
export const nodeCreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  node_type_id: z.string().min(1, "Type is required"),
});

export const createUserSchema = z.object({
  email: z.email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  full_name: z.string().optional(),
  is_superuser: z.boolean().optional(),
});

// Admin edit form: password is optional here -- an empty string means
// "leave unchanged" (validated as non-empty only if actually provided),
// since PATCH /users/{id} treats every field as optional.
export const editUserSchema = z.object({
  email: z.email("Invalid email").optional(),
  full_name: z.string().optional(),
  is_superuser: z.boolean().optional(),
  admission_status: z.enum(["pending", "approved", "rejected"]),
  password: z
    .string()
    .refine((v) => v === "" || v.length >= 8, "Must be at least 8 characters")
    .optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateMeInput = z.infer<typeof updateMeSchema>;
export type FirstNodeTypeInput = z.infer<typeof firstNodeTypeSchema>;
export type AppendNodeTypeInput = z.infer<typeof appendNodeTypeSchema>;
export type RenameNodeTypeInput = z.infer<typeof renameNodeTypeSchema>;
export type NodeNameInput = z.infer<typeof nodeNameSchema>;
export type DeviceAssignmentInput = z.infer<typeof deviceAssignmentSchema>;
export type NodeCreateInput = z.infer<typeof nodeCreateSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type EditUserInput = z.infer<typeof editUserSchema>;
