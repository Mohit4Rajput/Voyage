// Pass an authenticated Supabase JS client. This module never receives provider keys.
export function createTravelApi(supabase) {
  async function command(action, input) {
    const { data, error } = await supabase.functions.invoke('trip-api', { body: { action, ...input } });
    if (error) {
      if (error.context instanceof Response) {
        const payload = await error.context.clone().json().catch(() => null);
        if (payload?.error) throw Object.assign(new Error(payload.error.message), { code: payload.error.code });
      }
      throw error;
    }
    if (data.error) throw Object.assign(new Error(data.error.message), { code: data.error.code });
    return data.data;
  }
  async function rows(table, query) {
    const { data, error } = await query(supabase.from(table).select('*'));
    if (error) throw error;
    return data;
  }
  return {
    async startGuest() {
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      if (session) return session;
      const { data, error } = await supabase.auth.signInAnonymously();
      if (error) throw error;
      return data.session;
    },
    getContactEmail: () => command('get-contact-email', {}),
    saveContactEmail: email => command('save-contact-email', { email }),
    saveBrief: (brief, tripId = null, expectedRevision = 0) => command('save-brief', { brief, tripId, expectedRevision }),
    researchOptions: (tripId, revision, requestId = crypto.randomUUID()) => command('research-options', { tripId, revision, requestId }),
    selectOption: (tripId, revision, optionId) => command('select-option', { tripId, revision, optionId }),
    buildItinerary: (tripId, revision, requestId = crypto.randomUUID()) => command('build-itinerary', { tripId, revision, requestId }),
    cancelResearch: jobId => command('cancel-research', { jobId }),
    lockPlan: planId => command('lock-plan', { planId }),
    createOptionsShare: (tripId, jobId) => command('create-options-share', { tripId, jobId }),
    resolveOptionsShare: token => command('resolve-options-share', { token }),
    revokeOptionsShare: shareId => command('revoke-options-share', { shareId }),
    createShare: planId => command('create-share', { planId }),
    resolveShare: token => command('resolve-share', { token }),
    revokeShare: shareId => command('revoke-share', { shareId }),
    listTrips: () => rows('trips', q => q.order('updated_at', { ascending: false })),
    getBrief: (tripId, revision) => rows('trip_brief_revisions', q => q.eq('trip_id', tripId).eq('revision', revision).single()),
    getJob: jobId => rows('research_jobs', q => q.eq('id', jobId).single()),
    getOptions: jobId => rows('trip_options', q => q.eq('job_id', jobId).order('rank')),
    getSources: jobId => rows('research_sources', q => q.eq('job_id', jobId)),
    getPlans: tripId => rows('itinerary_versions', q => q.eq('trip_id', tripId).order('created_at', { ascending: false })),
    async waitForJob(jobId, { signal, onProgress = () => {}, intervalMs = 3000, timeoutMs = 1200000 } = {}) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        signal?.throwIfAborted();
        const job = await rows('research_jobs', q => q.eq('id', jobId).single());
        onProgress(job);
        if (['completed','failed','cancelled'].includes(job.status)) return job;
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, intervalMs);
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
      throw new Error('Research is still running. Resume polling later; do not start a duplicate job.');
    },
  };
}
