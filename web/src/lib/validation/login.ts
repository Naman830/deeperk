import { z } from "zod";
import { emailSchema } from "./signup";

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});
