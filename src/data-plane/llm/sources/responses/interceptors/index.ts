import { stripUnsupportedTools } from './strip-unsupported-tools.ts';
import type { ResponsesInterceptor } from '../../../interceptors.ts';

export const responsesSourceInterceptors = [
  stripUnsupportedTools,
] satisfies readonly ResponsesInterceptor[];
