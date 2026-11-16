import { ApiError } from './api.ts';
import { apiErrorText, currentLang } from './i18n.ts';

export const errorText = (error: unknown): string => (error instanceof ApiError || error instanceof Error ? apiErrorText(currentLang(), error.message) : currentLang() === 'ko' ? '문제가 발생했습니다.' : 'Something went wrong');
