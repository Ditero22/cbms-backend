import { z } from 'zod'

export const passwordRequirements = [
  { key: 'length', label: 'At least 8 characters', test: (value: string) => value.length >= 8 },
  { key: 'uppercase', label: 'An uppercase letter', test: (value: string) => /[A-Z]/.test(value) },
  { key: 'lowercase', label: 'A lowercase letter', test: (value: string) => /[a-z]/.test(value) },
  { key: 'number', label: 'A number', test: (value: string) => /[0-9]/.test(value) },
  {
    key: 'special',
    label: 'A special character',
    test: (value: string) => /[^A-Za-z0-9]/.test(value),
  },
] as const

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long.')
  .max(128, 'Password must be 128 characters or fewer.')
  .superRefine((value, context) => {
    for (const requirement of passwordRequirements.slice(1)) {
      if (!requirement.test(value)) {
        context.addIssue({
          code: 'custom',
          message: `Password must include ${requirement.label.toLowerCase()}.`,
        })
      }
    }
  })
