import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/** Polls the API health endpoint every 30s. */
export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => api.health({ signal }),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
