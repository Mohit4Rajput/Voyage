import { AppError, normalizeBrief, uuid, integer, text, newShareToken, hashShareToken } from './domain.mjs';

// Shared by the deployed Edge handler and the local Postgres test server.
export async function buildCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_JSON', 'Expected a JSON object.');
  let name, args, issuedToken = null;
  switch (body.action) {
    case 'get-contact-email': name='get_contact_email';args={};break;
    case 'save-contact-email': {
      const email=body.email===null||body.email===''?null:text(body.email,'email',254);
      if(email!==null&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new AppError('VALIDATION_ERROR','Enter a valid email address.');
      name='save_contact_email';args={p_email:email};break;
    }
    case 'save-brief':
      name='save_travel_brief'; args={p_trip_id:body.tripId?uuid(body.tripId):null,p_expected_revision:integer(body.expectedRevision,'expectedRevision',0,1000000),p_brief:normalizeBrief(body.brief)}; break;
    case 'research-options': case 'build-itinerary':
      name='enqueue_research'; args={p_trip_id:uuid(body.tripId),p_revision:integer(body.revision,'revision',1,1000000),p_kind:body.action==='research-options'?'options':'itinerary',p_request_key:uuid(body.requestId,'requestId')}; break;
    case 'select-option': name='choose_trip_option'; args={p_trip_id:uuid(body.tripId),p_revision:integer(body.revision,'revision',1,1000000),p_option_id:uuid(body.optionId)}; break;
    case 'cancel-research': name='cancel_research'; args={p_job_id:uuid(body.jobId)}; break;
    case 'lock-plan': name='lock_itinerary'; args={p_plan_id:uuid(body.planId)}; break;
    case 'create-options-share': issuedToken=newShareToken();name='create_options_share';args={p_trip_id:uuid(body.tripId),p_job_id:uuid(body.jobId),p_token_hash:await hashShareToken(issuedToken)};break;
    case 'resolve-options-share': name='resolve_options_share';args={p_token_hash:await hashShareToken(body.token)};break;
    case 'revoke-options-share': name='revoke_options_share';args={p_share_id:uuid(body.shareId)};break;
    case 'create-share':
      issuedToken=newShareToken();name='create_plan_share';args={p_plan_id:uuid(body.planId),p_token_hash:await hashShareToken(issuedToken)};break;
    case 'resolve-share':name='resolve_plan_share';args={p_token_hash:await hashShareToken(body.token)};break;
    case 'revoke-share':name='revoke_plan_share';args={p_share_id:uuid(body.shareId)};break;
    default:throw new AppError('UNKNOWN_ACTION','Unsupported backend action.');
  }
  return {name,args,issuedToken};
}
export function mapDatabaseError(message) {
  const codes={NOT_FOUND:404,UNAUTHORIZED:401,CONFLICT:409,INVALID_OPTION:400,RATE_LIMITED:429,SELECT_OPTION_FIRST:400,RESEARCH_ALREADY_RUNNING:409,BUDGET_UNRESOLVED:422,POLL_CLOSED:409,INVITE_ALREADY_USED:409};
  for(const [code,status]of Object.entries(codes))if(message.includes(code))return new AppError(code,code.replaceAll('_',' ').toLowerCase(),status);
  if(message.includes('VALIDATION_ERROR'))return new AppError('VALIDATION_ERROR','The saved input is invalid.');
  return new AppError('DATABASE_ERROR','Database operation failed.',500);
}
