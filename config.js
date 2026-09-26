// Configuration publique du dashboard HelioPulse.
// Cette clé doit être la clé anon/public Supabase, jamais la clé service_role.
window.HELIOPULSE_CONFIG = {
  supabaseUrl: 'https://cwlzpxclfytmchrgjpdm.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN3bHpweGNsZnl0bWNocmdqcGRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MjgyNDcsImV4cCI6MjEwNTQwNDI0N30.Tasv9tjQong7p3sexLK1ofiib6EP2SD4xFE0XXkNfXk',

  // Supabase Auth identifie un compte par un email : il n'existe pas de champ
  // « identifiant ». Le compte est admin@gmail.com, donc ce domaine permet de
  // se connecter en tapant seulement `admin`. Un email complet saisi dans le
  // formulaire n'est jamais transformé.
  //
  // ATTENTION — le domaine doit être REEL : Supabase refuse les adresses dont
  // le domaine ne résout pas, avec « Email address ... is invalid ». Vérifié
  // sur ce projet : heliopulse.local et heliopulse.app sont rejetés,
  // gmail.com et inphb.ci passent.
  authEmailDomain: 'gmail.com'
};
