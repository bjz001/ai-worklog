"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiRequestError, fetchApi } from "@/lib/api-client";

export function useApiResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchApi<T>(path, { signal: controller.signal })
      .then((payload) => {
        setData(payload);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof Error
            ? requestError
            : new ApiRequestError({ status: 0 })
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [path, revision]);

  return { data, error, loading, reload };
}
