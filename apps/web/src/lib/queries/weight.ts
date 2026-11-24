/**
 * Body weight: summary query + log / goal mutations. Keys live under qk.trends so the Day page
 * check-in (which invalidates trends) refreshes the weight views too.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LocalDate, WeightSummary } from '@cadence/core';
import { api, call } from '@/lib/api';
import { qk } from '@/lib/query';

export const weightKey = (from?: LocalDate, to?: LocalDate) => qk.trends.of('weight', { from, to });

export function useWeight(from?: LocalDate, to?: LocalDate) {
  return useQuery({
    queryKey: weightKey(from, to),
    queryFn: () => call(api.weight.$get({ query: { ...(from ? { from } : {}), ...(to ? { to } : {}) } })) as Promise<WeightSummary>,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

function useInvalidateWeight() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: qk.trends.all }),
      qc.invalidateQueries({ queryKey: qk.today }),
      qc.invalidateQueries({ queryKey: qk.calendar.all }),
      qc.invalidateQueries({ queryKey: qk.settings }),
    ]);
}

export function useLogWeight() {
  const invalidate = useInvalidateWeight();
  return useMutation({
    mutationFn: ({ date, weightKg }: { date: LocalDate; weightKg: number | null }) => call(api.weight[':date'].$put({ param: { date }, json: { weightKg } })),
    onSettled: invalidate,
  });
}

export function useSetWeightGoal() {
  const invalidate = useInvalidateWeight();
  return useMutation({
    mutationFn: (goal: { targetKg: number; targetDate?: LocalDate }) => call(api.weight.goal.$put({ json: goal })) as Promise<WeightSummary>,
    onSettled: invalidate,
  });
}

export function useClearWeightGoal() {
  const invalidate = useInvalidateWeight();
  return useMutation({
    mutationFn: () => call(api.weight.goal.$delete()) as Promise<WeightSummary>,
    onSettled: invalidate,
  });
}
