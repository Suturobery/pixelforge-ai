import { z } from 'zod';
export declare const brainHexColor: z.ZodString;
export declare const brainPlanStepSchema: z.ZodObject<{
    kind: z.ZodEnum<{
        "app-vfx": "app-vfx";
        "app-palette": "app-palette";
        agent: "agent";
    }>;
    title: z.ZodString;
    effect: z.ZodOptional<z.ZodString>;
    seed: z.ZodOptional<z.ZodNumber>;
    light: z.ZodOptional<z.ZodNumber>;
    colors: z.ZodOptional<z.ZodArray<z.ZodString>>;
    detail: z.ZodOptional<z.ZodString>;
    palette: z.ZodOptional<z.ZodLiteral<"project">>;
}, z.core.$strict>;
export declare const brainPlanSchema: z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            "app-vfx": "app-vfx";
            "app-palette": "app-palette";
            agent: "agent";
        }>;
        title: z.ZodString;
        effect: z.ZodOptional<z.ZodString>;
        seed: z.ZodOptional<z.ZodNumber>;
        light: z.ZodOptional<z.ZodNumber>;
        colors: z.ZodOptional<z.ZodArray<z.ZodString>>;
        detail: z.ZodOptional<z.ZodString>;
        palette: z.ZodOptional<z.ZodLiteral<"project">>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type BrainPlanStep = z.infer<typeof brainPlanStepSchema>;
