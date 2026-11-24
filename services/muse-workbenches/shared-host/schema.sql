--
-- PostgreSQL database dump
--

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: agent_ckpt; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA agent_ckpt;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: checkpoint_blobs; Type: TABLE; Schema: agent_ckpt; Owner: -
--

CREATE TABLE agent_ckpt.checkpoint_blobs (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    channel text NOT NULL,
    version text NOT NULL,
    type text NOT NULL,
    blob bytea
);


--
-- Name: checkpoint_migrations; Type: TABLE; Schema: agent_ckpt; Owner: -
--

CREATE TABLE agent_ckpt.checkpoint_migrations (
    v integer NOT NULL
);


--
-- Name: checkpoint_writes; Type: TABLE; Schema: agent_ckpt; Owner: -
--

CREATE TABLE agent_ckpt.checkpoint_writes (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    checkpoint_id text NOT NULL,
    task_id text NOT NULL,
    idx integer NOT NULL,
    channel text NOT NULL,
    type text,
    blob bytea NOT NULL,
    task_path text DEFAULT ''::text NOT NULL
);


--
-- Name: checkpoints; Type: TABLE; Schema: agent_ckpt; Owner: -
--

CREATE TABLE agent_ckpt.checkpoints (
    thread_id text NOT NULL,
    checkpoint_ns text DEFAULT ''::text NOT NULL,
    checkpoint_id text NOT NULL,
    parent_checkpoint_id text,
    type text,
    checkpoint jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: agent_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_approvals (
    id integer NOT NULL,
    run_id integer NOT NULL,
    interrupt_id character varying(64) NOT NULL,
    idx integer NOT NULL,
    tool character varying(64) NOT NULL,
    args jsonb DEFAULT '{}'::jsonb NOT NULL,
    risk character varying(16),
    description text,
    status character varying(16) DEFAULT 'pending'::character varying NOT NULL,
    note text,
    decided_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_approvals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_approvals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_approvals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_approvals_id_seq OWNED BY public.agent_approvals.id;


--
-- Name: agent_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_artifacts (
    id integer NOT NULL,
    conversation_id integer NOT NULL,
    message_id integer,
    user_id integer NOT NULL,
    kind character varying(16),
    title character varying(256),
    content text,
    metadata_json jsonb,
    is_pinned boolean,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_artifacts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_artifacts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_artifacts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_artifacts_id_seq OWNED BY public.agent_artifacts.id;


--
-- Name: agent_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_attachments (
    id integer NOT NULL,
    conversation_id integer NOT NULL,
    message_id integer,
    user_id integer NOT NULL,
    kind character varying(16),
    filename character varying(256),
    oss_url character varying(512),
    size_bytes integer,
    mime_type character varying(64),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_attachments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_attachments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_attachments_id_seq OWNED BY public.agent_attachments.id;


--
-- Name: agent_batch_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_batch_jobs (
    id integer NOT NULL,
    user_id integer,
    title character varying(200),
    filter_json json,
    action_chain json,
    params_json json,
    auto_apply integer,
    status character varying(20),
    total integer,
    finished integer,
    failed integer,
    items_json json,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: agent_batch_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_batch_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_batch_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_batch_jobs_id_seq OWNED BY public.agent_batch_jobs.id;


--
-- Name: agent_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_conversations (
    id integer NOT NULL,
    user_id integer NOT NULL,
    draft_id integer,
    title character varying(120),
    is_deleted boolean,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    unread_count integer DEFAULT 0,
    last_read_at timestamp without time zone,
    model character varying(32),
    source character varying(16) DEFAULT 'studio'::character varying NOT NULL
);


--
-- Name: agent_conversations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_conversations_id_seq OWNED BY public.agent_conversations.id;


--
-- Name: agent_document_chapters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_document_chapters (
    id integer NOT NULL,
    document_id integer NOT NULL,
    "order" integer NOT NULL,
    title character varying(256) DEFAULT ''::character varying,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    char_count integer DEFAULT 0
);


--
-- Name: agent_document_chapters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_document_chapters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_document_chapters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_document_chapters_id_seq OWNED BY public.agent_document_chapters.id;


--
-- Name: agent_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_documents (
    id integer NOT NULL,
    user_id integer NOT NULL,
    conversation_id integer,
    draft_id integer,
    filename character varying(256) DEFAULT ''::character varying,
    char_count integer DEFAULT 0,
    full_text text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_documents_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_documents_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_documents_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_documents_id_seq OWNED BY public.agent_documents.id;


--
-- Name: agent_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_images (
    id integer NOT NULL,
    user_id integer NOT NULL,
    conversation_id integer,
    message_id integer,
    filename character varying(256) DEFAULT ''::character varying,
    stored_name character varying(128) NOT NULL,
    mime character varying(64) DEFAULT 'image/jpeg'::character varying,
    byte_size integer DEFAULT 0,
    width integer DEFAULT 0,
    height integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_images_id_seq OWNED BY public.agent_images.id;


--
-- Name: agent_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_jobs (
    id integer NOT NULL,
    kind character varying(40) NOT NULL,
    draft_id integer,
    user_id integer,
    status character varying(16) NOT NULL,
    payload jsonb,
    result jsonb,
    error text,
    progress integer,
    progress_note text,
    lease_owner character varying(120),
    lease_expires_at timestamp without time zone,
    heartbeat_at timestamp without time zone,
    attempt integer,
    max_attempts integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_jobs_id_seq OWNED BY public.agent_jobs.id;


--
-- Name: agent_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_messages (
    id integer NOT NULL,
    conversation_id integer NOT NULL,
    role character varying(16) NOT NULL,
    content text NOT NULL,
    tokens_in integer,
    tokens_out integer,
    created_at timestamp without time zone DEFAULT now(),
    group_id integer,
    version integer DEFAULT 1,
    is_active boolean DEFAULT true,
    seq integer,
    report_json jsonb
);


--
-- Name: agent_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_messages_id_seq OWNED BY public.agent_messages.id;


--
-- Name: agent_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_operations (
    id integer NOT NULL,
    conversation_id integer NOT NULL,
    message_id integer,
    user_id integer NOT NULL,
    op_type character varying(40) NOT NULL,
    target_draft_id integer,
    target_chapter_order integer,
    target_field character varying(40),
    payload jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    confidence real,
    affected_chars integer,
    cascade_warnings jsonb DEFAULT '[]'::jsonb,
    reversible boolean DEFAULT true,
    expires_at timestamp without time zone,
    confirmed_at timestamp without time zone,
    applied_at timestamp without time zone,
    applied_result jsonb,
    rolled_back_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_operations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_operations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_operations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_operations_id_seq OWNED BY public.agent_operations.id;


--
-- Name: agent_run_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_events (
    id bigint NOT NULL,
    run_id integer NOT NULL,
    seq integer NOT NULL,
    type character varying(32) NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: agent_run_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_run_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_run_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_run_events_id_seq OWNED BY public.agent_run_events.id;


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    conversation_id integer NOT NULL,
    draft_id integer,
    profile character varying(16) NOT NULL,
    model character varying(80),
    status character varying(24) DEFAULT 'queued'::character varying NOT NULL,
    message text NOT NULL,
    final_text text,
    error text,
    cancel_requested boolean DEFAULT false NOT NULL,
    resume jsonb,
    usage jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    finished_at timestamp without time zone,
    writing_model character varying(80)
);


--
-- Name: agent_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.agent_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: agent_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.agent_runs_id_seq OWNED BY public.agent_runs.id;


--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: announcement_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_deliveries (
    id integer NOT NULL,
    push_id integer NOT NULL,
    user_id integer,
    user_name character varying(128) DEFAULT ''::character varying,
    status character varying(16) NOT NULL,
    reason character varying(300) DEFAULT ''::character varying,
    message_id character varying(120) DEFAULT ''::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: announcement_deliveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcement_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcement_deliveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcement_deliveries_id_seq OWNED BY public.announcement_deliveries.id;


--
-- Name: announcement_pushes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_pushes (
    id integer NOT NULL,
    announcement_id integer,
    title character varying(128) DEFAULT ''::character varying NOT NULL,
    text text NOT NULL,
    scope character varying(16) DEFAULT 'all'::character varying NOT NULL,
    target_ids jsonb,
    total integer DEFAULT 0,
    sent integer DEFAULT 0,
    failed integer DEFAULT 0,
    skipped integer DEFAULT 0,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: announcement_pushes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcement_pushes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcement_pushes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcement_pushes_id_seq OWNED BY public.announcement_pushes.id;


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id integer NOT NULL,
    title character varying(128) NOT NULL,
    content text NOT NULL,
    type character varying(16) DEFAULT 'info'::character varying,
    active boolean DEFAULT true,
    start_at timestamp without time zone,
    end_at timestamp without time zone,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: announcements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.announcements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: announcements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.announcements_id_seq OWNED BY public.announcements.id;


--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(80) NOT NULL,
    prefix character varying(16) NOT NULL,
    key_hash character varying(64) NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    last_used_at timestamp without time zone,
    revoked_at timestamp without time zone
);


--
-- Name: api_keys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_keys_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_keys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_keys_id_seq OWNED BY public.api_keys.id;


--
-- Name: api_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_usage_logs (
    id integer NOT NULL,
    user_id integer,
    draft_id integer,
    model_provider character varying(32),
    operation character varying(64),
    prompt_tokens integer DEFAULT 0,
    completion_tokens integer DEFAULT 0,
    total_tokens integer DEFAULT 0,
    estimated_cost numeric(10,6) DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: api_usage_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.api_usage_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: api_usage_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.api_usage_logs_id_seq OWNED BY public.api_usage_logs.id;


--
-- Name: audio_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audio_assets (
    id integer NOT NULL,
    job_id integer NOT NULL,
    user_id integer NOT NULL,
    oss_key text NOT NULL,
    fmt text,
    duration_ms integer,
    seq integer,
    meta jsonb,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: audio_assets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audio_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audio_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audio_assets_id_seq OWNED BY public.audio_assets.id;


--
-- Name: audio_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audio_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    provider text NOT NULL,
    model text,
    status text NOT NULL,
    progress integer,
    params jsonb,
    error text,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: audio_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audio_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audio_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audio_jobs_id_seq OWNED BY public.audio_jobs.id;


--
-- Name: auto_batch_genres; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_batch_genres (
    id integer NOT NULL,
    key character varying(40) NOT NULL,
    label character varying(40) NOT NULL,
    description text,
    prompt_hint text,
    is_builtin boolean,
    display_order integer,
    use_count integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: auto_batch_genres_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_batch_genres_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_batch_genres_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_batch_genres_id_seq OWNED BY public.auto_batch_genres.id;


--
-- Name: auto_batch_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_batch_jobs (
    id integer NOT NULL,
    name character varying(120),
    config_json json,
    status character varying(20),
    total_dramas integer,
    finished_dramas integer,
    failed_dramas integer,
    draft_ids json,
    current_step text,
    llm_calls_estimated integer,
    llm_calls_actual integer,
    error text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: auto_batch_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_batch_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_batch_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_batch_jobs_id_seq OWNED BY public.auto_batch_jobs.id;


--
-- Name: auto_batch_transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auto_batch_transfers (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    source_user_id integer NOT NULL,
    target_user_id integer NOT NULL,
    copied_draft_id integer NOT NULL,
    job_id integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: auto_batch_transfers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auto_batch_transfers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auto_batch_transfers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auto_batch_transfers_id_seq OWNED BY public.auto_batch_transfers.id;


--
-- Name: chapter_adapt_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chapter_adapt_jobs (
    id integer NOT NULL,
    user_id integer,
    draft_id integer,
    kind character varying(16) NOT NULL,
    status character varying(20),
    model character varying(64),
    protagonist character varying(64),
    total integer,
    finished integer,
    per_ep_json jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    finished_at timestamp without time zone
);


--
-- Name: chapter_adapt_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chapter_adapt_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chapter_adapt_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chapter_adapt_jobs_id_seq OWNED BY public.chapter_adapt_jobs.id;


--
-- Name: chapter_adaptations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chapter_adaptations (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    kind character varying(16) NOT NULL,
    chapter_order integer NOT NULL,
    content text,
    word_count integer,
    version integer,
    user_edited boolean,
    meta_json jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: chapter_adaptations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chapter_adaptations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chapter_adaptations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chapter_adaptations_id_seq OWNED BY public.chapter_adaptations.id;


--
-- Name: character_consistency_warnings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_consistency_warnings (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    character_id integer,
    character_name character varying(64),
    chapter_orders json,
    warning_type character varying(32),
    severity character varying(8),
    description text,
    suggestion text,
    resolved boolean,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: character_consistency_warnings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_consistency_warnings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_consistency_warnings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_consistency_warnings_id_seq OWNED BY public.character_consistency_warnings.id;


--
-- Name: character_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.character_relationships (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    from_character_id integer NOT NULL,
    to_character_id integer NOT NULL,
    relation_type character varying(32),
    strength integer,
    description text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: character_relationships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.character_relationships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: character_relationships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.character_relationships_id_seq OWNED BY public.character_relationships.id;


--
-- Name: characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.characters (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    name character varying(64) NOT NULL,
    role character varying(32),
    appearance text,
    personality text,
    backstory text,
    avatar_url character varying(512),
    avatar_prompt text,
    traits json,
    is_active boolean,
    sort_order integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: characters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.characters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: characters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.characters_id_seq OWNED BY public.characters.id;


--
-- Name: check_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.check_reports (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    user_id integer DEFAULT 0 NOT NULL,
    kinds jsonb DEFAULT '[]'::jsonb NOT NULL,
    scope jsonb,
    report jsonb DEFAULT '{}'::jsonb NOT NULL,
    issue_index jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: check_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.check_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: check_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.check_reports_id_seq OWNED BY public.check_reports.id;


--
-- Name: clip_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clip_assets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    is_public boolean,
    category character varying(80),
    title character varying(160),
    video_oss_key character varying(255),
    video_url text,
    cover_url text,
    duration_s integer,
    size_bytes integer,
    description text,
    prompt text,
    status character varying(24),
    error text,
    batch_id character varying(48),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: clip_assets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clip_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clip_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clip_assets_id_seq OWNED BY public.clip_assets.id;


--
-- Name: clip_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clip_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    title character varying(120),
    input_kind character varying(16),
    input_text text,
    creative text,
    video_prompt text,
    image_prompt text,
    highlights text,
    image_oss_key character varying(255),
    image_url text,
    params jsonb,
    rh_task_id character varying(64),
    video_oss_key character varying(255),
    video_url text,
    status character varying(24),
    error text,
    progress integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: clip_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clip_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clip_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clip_jobs_id_seq OWNED BY public.clip_jobs.id;


--
-- Name: content_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_history (
    id integer NOT NULL,
    draft_id integer,
    chapter_order integer,
    stage character varying(32) NOT NULL,
    content jsonb,
    change_reason character varying(128),
    user_feedback text,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: content_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_history_id_seq OWNED BY public.content_history.id;


--
-- Name: critique_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.critique_config (
    id integer NOT NULL,
    config_json jsonb,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: critique_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.critique_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: critique_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.critique_config_id_seq OWNED BY public.critique_config.id;


--
-- Name: critique_issues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.critique_issues (
    id integer NOT NULL,
    run_id integer NOT NULL,
    episode_order integer NOT NULL,
    round integer NOT NULL,
    theme text,
    role text,
    severity text,
    confidence integer,
    issue text,
    evidence text,
    fix_hint text,
    locator jsonb,
    status text,
    reject_reason text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: critique_issues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.critique_issues_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: critique_issues_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.critique_issues_id_seq OWNED BY public.critique_issues.id;


--
-- Name: critique_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.critique_runs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    draft_id integer NOT NULL,
    source text NOT NULL,
    intensity text NOT NULL,
    status text NOT NULL,
    progress integer,
    params jsonb,
    progress_json jsonb,
    result_json jsonb,
    applied integer,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: critique_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.critique_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: critique_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.critique_runs_id_seq OWNED BY public.critique_runs.id;


--
-- Name: deai_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deai_jobs (
    id integer NOT NULL,
    user_id integer,
    draft_id integer,
    title character varying(256),
    status character varying(20),
    total integer,
    finished integer,
    failed integer,
    rewrite integer,
    inject_level character varying(16),
    allow_typo integer,
    model character varying(64),
    per_ep_json jsonb,
    summary_json jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    finished_at timestamp without time zone
);


--
-- Name: deai_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deai_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deai_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deai_jobs_id_seq OWNED BY public.deai_jobs.id;


--
-- Name: desktop_reminders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.desktop_reminders (
    id integer NOT NULL,
    user_id integer NOT NULL,
    job_id integer NOT NULL,
    job_kind character varying(24) NOT NULL,
    text character varying(500) NOT NULL,
    status character varying(12) NOT NULL,
    attempts integer NOT NULL,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    sent_at timestamp without time zone
);


--
-- Name: desktop_reminders_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.desktop_reminders_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: desktop_reminders_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.desktop_reminders_id_seq OWNED BY public.desktop_reminders.id;


--
-- Name: draft_batch_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_batch_jobs (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    user_id integer NOT NULL,
    kind character varying(32) NOT NULL,
    config_json json,
    target_episodes json,
    status character varying(16),
    progress_current integer,
    progress_total integer,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: draft_batch_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_batch_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_batch_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_batch_jobs_id_seq OWNED BY public.draft_batch_jobs.id;


--
-- Name: draft_batch_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_batch_logs (
    id integer NOT NULL,
    job_id integer NOT NULL,
    episode_order integer,
    log_type character varying(16),
    message text,
    log_metadata json,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_batch_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_batch_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_batch_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_batch_logs_id_seq OWNED BY public.draft_batch_logs.id;


--
-- Name: draft_character_images; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_character_images (
    id integer NOT NULL,
    character_id integer NOT NULL,
    oss_key text NOT NULL,
    episodes jsonb,
    seq integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_character_images_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_character_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_character_images_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_character_images_id_seq OWNED BY public.draft_character_images.id;


--
-- Name: draft_characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_characters (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    name text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_characters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_characters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_characters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_characters_id_seq OWNED BY public.draft_characters.id;


--
-- Name: draft_episode_image_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_episode_image_config (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    chapter_order integer NOT NULL,
    mode text NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_episode_image_config_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_episode_image_config_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_episode_image_config_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_episode_image_config_id_seq OWNED BY public.draft_episode_image_config.id;


--
-- Name: draft_extend_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_extend_configs (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    default_target_episodes integer,
    default_chunk_size integer,
    default_word_target integer,
    default_provider character varying(16),
    forced_level character varying(8),
    user_guidance_template text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_extend_configs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_extend_configs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_extend_configs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_extend_configs_id_seq OWNED BY public.draft_extend_configs.id;


--
-- Name: draft_image_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_image_tasks (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    user_id integer NOT NULL,
    chapter_order integer NOT NULL,
    mode text NOT NULL,
    group_index integer,
    shot_indexes jsonb NOT NULL,
    image_prompt text,
    status text NOT NULL,
    progress integer,
    error text,
    model text,
    size text,
    ref_image_keys jsonb,
    ref_labels jsonb,
    result_keys jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_image_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_image_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_image_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_image_tasks_id_seq OWNED BY public.draft_image_tasks.id;


--
-- Name: draft_read_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_read_state (
    id integer NOT NULL,
    user_id integer NOT NULL,
    draft_id integer NOT NULL,
    stream character varying(32) NOT NULL,
    seen_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: draft_read_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.draft_read_state_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: draft_read_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.draft_read_state_id_seq OWNED BY public.draft_read_state.id;


--
-- Name: draft_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.draft_tags (
    draft_id integer NOT NULL,
    tag_id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: email_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verifications (
    id integer NOT NULL,
    email character varying(128) NOT NULL,
    code character varying(8) NOT NULL,
    purpose character varying(16),
    status character varying(16),
    attempts integer,
    ip character varying(45),
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL,
    verified_at timestamp without time zone
);


--
-- Name: email_verifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_verifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: email_verifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_verifications_id_seq OWNED BY public.email_verifications.id;


--
-- Name: export_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.export_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    draft_id integer,
    kind character varying(32) NOT NULL,
    config_json json,
    status character varying(16),
    progress integer,
    output_url character varying(512),
    error text,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: export_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.export_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: export_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.export_jobs_id_seq OWNED BY public.export_jobs.id;


--
-- Name: factory_dist_targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_dist_targets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(200) NOT NULL,
    url text NOT NULL,
    field_mapping jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: factory_dist_targets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_dist_targets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_dist_targets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_dist_targets_id_seq OWNED BY public.factory_dist_targets.id;


--
-- Name: factory_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    job_type character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    cached_tokens integer DEFAULT 0 NOT NULL,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    finished_at timestamp without time zone
);


--
-- Name: factory_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_jobs_id_seq OWNED BY public.factory_jobs.id;


--
-- Name: factory_pipeline_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_pipeline_runs (
    id integer NOT NULL,
    pipeline_id integer NOT NULL,
    user_id integer NOT NULL,
    pipeline_name character varying(200),
    status character varying(30) NOT NULL,
    current_step integer NOT NULL,
    total_steps integer NOT NULL,
    step_runs jsonb NOT NULL,
    error_message text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    finished_at timestamp without time zone
);


--
-- Name: factory_pipeline_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_pipeline_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_pipeline_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_pipeline_runs_id_seq OWNED BY public.factory_pipeline_runs.id;


--
-- Name: factory_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_pipelines (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(200) NOT NULL,
    steps jsonb NOT NULL,
    model_config jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: factory_pipelines_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_pipelines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_pipelines_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_pipelines_id_seq OWNED BY public.factory_pipelines.id;


--
-- Name: factory_products; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_products (
    id integer NOT NULL,
    job_id integer NOT NULL,
    user_id integer NOT NULL,
    product_type character varying(50) NOT NULL,
    title character varying(500),
    content text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    quality_score double precision,
    parent_id integer,
    draft_id integer,
    status character varying(50) DEFAULT 'completed'::character varying NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: factory_products_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_products_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_products_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_products_id_seq OWNED BY public.factory_products.id;


--
-- Name: factory_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.factory_stats (
    id integer NOT NULL,
    date date NOT NULL,
    total_jobs integer DEFAULT 0 NOT NULL,
    success_jobs integer DEFAULT 0 NOT NULL,
    failed_jobs integer DEFAULT 0 NOT NULL,
    total_tokens bigint DEFAULT '0'::bigint NOT NULL,
    job_type_dist jsonb DEFAULT '{}'::jsonb NOT NULL,
    avg_duration double precision,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: factory_stats_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.factory_stats_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: factory_stats_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.factory_stats_id_seq OWNED BY public.factory_stats.id;


--
-- Name: feishu_bitable_syncs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_bitable_syncs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text DEFAULT '飞书自动化'::text NOT NULL,
    app_token text NOT NULL,
    table_id text NOT NULL,
    field_map jsonb NOT NULL,
    default_ratio text DEFAULT '4:3'::text,
    default_style_prompt text DEFAULT ''::text,
    default_per_image_seconds integer DEFAULT 7,
    overlay_layout jsonb,
    cover_enabled integer DEFAULT 1,
    cover_layout jsonb,
    voice_oss_keys jsonb,
    bgm_category text,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    voice_mode text
);


--
-- Name: feishu_bitable_syncs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feishu_bitable_syncs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feishu_bitable_syncs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feishu_bitable_syncs_id_seq OWNED BY public.feishu_bitable_syncs.id;


--
-- Name: feishu_reverse_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_reverse_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    status text NOT NULL,
    progress integer,
    error text,
    source_ref text,
    app_token text,
    table_id text,
    field_map jsonb,
    total integer,
    done integer,
    ok integer,
    skip integer,
    fail integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: feishu_reverse_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feishu_reverse_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feishu_reverse_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feishu_reverse_jobs_id_seq OWNED BY public.feishu_reverse_jobs.id;


--
-- Name: feishu_row_failures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feishu_row_failures (
    id integer NOT NULL,
    cfg_id integer NOT NULL,
    record_id text NOT NULL,
    user_id integer NOT NULL,
    status text NOT NULL,
    reason text,
    job_id integer,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: feishu_row_failures_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feishu_row_failures_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feishu_row_failures_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feishu_row_failures_id_seq OWNED BY public.feishu_row_failures.id;


--
-- Name: frontcut_corpus_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frontcut_corpus_items (
    id integer NOT NULL,
    user_id integer NOT NULL,
    is_preset boolean,
    title character varying(200),
    source character varying(16),
    content text,
    video_oss_key character varying(255),
    video_url text,
    status character varying(24),
    error text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    protagonist_gender character varying(16) DEFAULT ''::character varying,
    protagonist_role character varying(100) DEFAULT ''::character varying,
    theme_tags json,
    hook_type character varying(50) DEFAULT ''::character varying,
    scenario_summary character varying(300) DEFAULT ''::character varying,
    content_rating character varying(20) DEFAULT 'safe'::character varying,
    auto_tagged boolean DEFAULT false,
    tag_version integer DEFAULT 0
);


--
-- Name: frontcut_corpus_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frontcut_corpus_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frontcut_corpus_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frontcut_corpus_items_id_seq OWNED BY public.frontcut_corpus_items.id;


--
-- Name: frontcut_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frontcut_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    status text NOT NULL,
    progress integer,
    error text,
    source_video_oss_key text,
    source_video_url text,
    ratio text,
    resolution text NOT NULL,
    duration integer NOT NULL,
    user_ref text,
    reverse_summary text,
    prompt_candidates jsonb,
    video_candidates jsonb,
    picked_framework_id text,
    final_video_oss_key text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    voice_ref_oss_key text,
    narration_audio_oss_key text,
    ref_image_oss_key text,
    corpus_ids jsonb,
    first_frame_desc text
);


--
-- Name: frontcut_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frontcut_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frontcut_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frontcut_jobs_id_seq OWNED BY public.frontcut_jobs.id;


--
-- Name: frontcut_voice_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frontcut_voice_refs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    oss_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: frontcut_voice_refs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frontcut_voice_refs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frontcut_voice_refs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frontcut_voice_refs_id_seq OWNED BY public.frontcut_voice_refs.id;


--
-- Name: generation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generation_logs (
    id integer NOT NULL,
    draft_id integer,
    stage text,
    chapter_order integer DEFAULT 0,
    log_type text,
    message text,
    log_metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now(),
    user_id integer
);


--
-- Name: generation_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generation_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generation_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generation_logs_id_seq OWNED BY public.generation_logs.id;


--
-- Name: generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generations (
    id integer NOT NULL,
    session_id character varying(64),
    user_input text,
    outline text,
    final_script text,
    quality_score double precision,
    matched_modules json,
    duration_ms integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: generations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generations_id_seq OWNED BY public.generations.id;


--
-- Name: image_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_assets (
    id integer NOT NULL,
    job_id integer NOT NULL,
    user_id integer NOT NULL,
    oss_key text NOT NULL,
    width integer,
    height integer,
    kind text NOT NULL,
    seq integer,
    meta jsonb,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: image_assets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_assets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_assets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_assets_id_seq OWNED BY public.image_assets.id;


--
-- Name: image_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_billing (
    id integer NOT NULL,
    job_id integer NOT NULL,
    user_id integer NOT NULL,
    kind text NOT NULL,
    model text NOT NULL,
    unit text NOT NULL,
    quantity double precision NOT NULL,
    unit_price double precision NOT NULL,
    amount double precision NOT NULL,
    detail jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: image_billing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_billing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_billing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_billing_id_seq OWNED BY public.image_billing.id;


--
-- Name: image_generation_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_generation_quotas (
    id integer NOT NULL,
    user_id integer NOT NULL,
    quota_date character varying(10),
    used_count integer,
    daily_limit integer,
    kind character varying(16),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: image_generation_quotas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_generation_quotas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_generation_quotas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_generation_quotas_id_seq OWNED BY public.image_generation_quotas.id;


--
-- Name: image_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    kind text NOT NULL,
    provider text NOT NULL,
    model text,
    status text NOT NULL,
    progress integer,
    params jsonb,
    remote_task_id text,
    parent_job_id integer,
    error text,
    expires_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: image_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_jobs_id_seq OWNED BY public.image_jobs.id;


--
-- Name: image_prompt_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_prompt_presets (
    id integer NOT NULL,
    name text NOT NULL,
    category text,
    prefix_text text NOT NULL,
    negative_text text,
    sort_order integer,
    enabled boolean,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: image_prompt_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.image_prompt_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: image_prompt_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.image_prompt_presets_id_seq OWNED BY public.image_prompt_presets.id;


--
-- Name: llm_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.llm_usage_logs (
    id integer NOT NULL,
    job_id integer,
    user_id integer,
    stage character varying(50),
    provider character varying(30),
    model character varying(100),
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    attribution_source character varying(40) DEFAULT ''::character varying NOT NULL,
    channel character varying(40),
    duration_ms integer,
    ok boolean DEFAULT true,
    error character varying(300),
    cached_tokens integer DEFAULT 0
);


--
-- Name: llm_usage_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.llm_usage_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: llm_usage_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.llm_usage_logs_id_seq OWNED BY public.llm_usage_logs.id;


--
-- Name: model_channel_health; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.model_channel_health (
    id integer NOT NULL,
    provider character varying(30) NOT NULL,
    model character varying(100) NOT NULL,
    channel character varying(30) NOT NULL,
    ok boolean DEFAULT false,
    stream_ok boolean,
    http_status integer,
    latency_ms integer,
    echo_model character varying(100) DEFAULT ''::character varying,
    echo_raw character varying(100) DEFAULT ''::character varying,
    substituted boolean DEFAULT false,
    error text,
    checked_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: model_channel_health_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.model_channel_health_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: model_channel_health_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.model_channel_health_id_seq OWNED BY public.model_channel_health.id;


--
-- Name: novel_video_audio_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_audio_chunks (
    id integer NOT NULL,
    job_id integer NOT NULL,
    idx integer NOT NULL,
    text_chunk text,
    audio_oss_key text,
    duration integer,
    status text,
    error text,
    rh_task_id text,
    created_at timestamp with time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: novel_video_audio_chunks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_audio_chunks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_audio_chunks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_audio_chunks_id_seq OWNED BY public.novel_video_audio_chunks.id;


--
-- Name: novel_video_bgm; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_bgm (
    id integer NOT NULL,
    user_id integer NOT NULL,
    category text NOT NULL,
    name text NOT NULL,
    oss_key text NOT NULL,
    duration integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: novel_video_bgm_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_bgm_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_bgm_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_bgm_id_seq OWNED BY public.novel_video_bgm.id;


--
-- Name: novel_video_cover_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_cover_presets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    layout jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: novel_video_cover_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_cover_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_cover_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_cover_presets_id_seq OWNED BY public.novel_video_cover_presets.id;


--
-- Name: novel_video_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_jobs (
    id integer NOT NULL,
    user_id integer NOT NULL,
    title text NOT NULL,
    novel_text text NOT NULL,
    style_prompt text,
    ref_image_oss_key text,
    ref_image_oss_keys jsonb,
    voice_ref_oss_key text,
    overlays jsonb,
    width integer,
    height integer,
    fps integer,
    per_image_seconds integer,
    image_model text,
    auto_compose integer,
    bgm_category text,
    bgm_oss_key text,
    status text NOT NULL,
    progress integer,
    error text,
    image_count integer,
    audio_duration integer,
    audio_oss_key text,
    video_oss_key text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    expires_at timestamp without time zone,
    cover_enabled integer DEFAULT 0,
    cover_title text,
    cover_tags text,
    cover_prompt text,
    cover_oss_key text,
    cover_overlays jsonb,
    source text,
    feishu_record_id text,
    protagonist_gender text,
    pending_action text,
    action_params jsonb
);


--
-- Name: novel_video_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_jobs_id_seq OWNED BY public.novel_video_jobs.id;


--
-- Name: novel_video_overlay_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_overlay_presets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    layout jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: novel_video_overlay_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_overlay_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_overlay_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_overlay_presets_id_seq OWNED BY public.novel_video_overlay_presets.id;


--
-- Name: novel_video_shots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_shots (
    id integer NOT NULL,
    job_id integer NOT NULL,
    idx integer NOT NULL,
    text_segment text,
    image_prompt text,
    image_oss_key text,
    status text,
    error text,
    regenerate_count integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: novel_video_shots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_shots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_shots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_shots_id_seq OWNED BY public.novel_video_shots.id;


--
-- Name: novel_video_style_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_style_presets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    prompt text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: novel_video_style_presets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_style_presets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_style_presets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_style_presets_id_seq OWNED BY public.novel_video_style_presets.id;


--
-- Name: novel_video_voices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.novel_video_voices (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    oss_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    gender text
);


--
-- Name: novel_video_voices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.novel_video_voices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: novel_video_voices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.novel_video_voices_id_seq OWNED BY public.novel_video_voices.id;


--
-- Name: nv_backup_20260712; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nv_backup_20260712 (
    id integer,
    user_id integer,
    title text,
    novel_text text,
    style_prompt text,
    ref_image_oss_key text,
    ref_image_oss_keys jsonb,
    voice_ref_oss_key text,
    overlays jsonb,
    width integer,
    height integer,
    fps integer,
    per_image_seconds integer,
    image_model text,
    auto_compose integer,
    bgm_category text,
    bgm_oss_key text,
    status text,
    progress integer,
    error text,
    image_count integer,
    audio_duration integer,
    audio_oss_key text,
    video_oss_key text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    expires_at timestamp without time zone,
    cover_enabled integer,
    cover_title text,
    cover_tags text,
    cover_prompt text,
    cover_oss_key text,
    cover_overlays jsonb,
    source text,
    feishu_record_id text,
    protagonist_gender text,
    pending_action text,
    action_params jsonb
);


--
-- Name: nv_backup_compositing_20260712; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nv_backup_compositing_20260712 (
    id integer,
    user_id integer,
    title text,
    novel_text text,
    style_prompt text,
    ref_image_oss_key text,
    ref_image_oss_keys jsonb,
    voice_ref_oss_key text,
    overlays jsonb,
    width integer,
    height integer,
    fps integer,
    per_image_seconds integer,
    image_model text,
    auto_compose integer,
    bgm_category text,
    bgm_oss_key text,
    status text,
    progress integer,
    error text,
    image_count integer,
    audio_duration integer,
    audio_oss_key text,
    video_oss_key text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    expires_at timestamp without time zone,
    cover_enabled integer,
    cover_title text,
    cover_tags text,
    cover_prompt text,
    cover_oss_key text,
    cover_overlays jsonb,
    source text,
    feishu_record_id text,
    protagonist_gender text,
    pending_action text,
    action_params jsonb
);


--
-- Name: outline_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outline_candidates (
    id integer NOT NULL,
    draft_id integer,
    batch_id integer NOT NULL,
    model_provider character varying(32),
    style_description text,
    user_style_preference text,
    outline jsonb DEFAULT '{}'::jsonb,
    is_selected boolean DEFAULT false,
    status character varying(16) DEFAULT 'generating'::character varying,
    error_message text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: outline_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outline_candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: outline_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outline_candidates_id_seq OWNED BY public.outline_candidates.id;


--
-- Name: polish_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.polish_jobs (
    id integer NOT NULL,
    user_id integer,
    title character varying(200),
    draft_ids json,
    max_rounds integer,
    target_score integer,
    target_p0 integer,
    status character varying(20),
    total integer,
    finished integer,
    failed integer,
    per_draft_json jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone
);


--
-- Name: polish_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.polish_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: polish_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.polish_jobs_id_seq OWNED BY public.polish_jobs.id;


--
-- Name: preset_backgrounds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preset_backgrounds (
    id integer NOT NULL,
    name character varying(128) NOT NULL,
    url character varying(512) NOT NULL,
    thumbnail_url character varying(512),
    tags text[],
    is_active boolean DEFAULT true,
    created_by integer,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: preset_backgrounds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.preset_backgrounds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: preset_backgrounds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.preset_backgrounds_id_seq OWNED BY public.preset_backgrounds.id;


--
-- Name: project_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_series (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name character varying(100),
    description text,
    shared_world jsonb DEFAULT '{}'::jsonb,
    shared_characters jsonb DEFAULT '[]'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: project_series_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.project_series_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: project_series_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.project_series_id_seq OWNED BY public.project_series.id;


--
-- Name: prompt_converter_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_converter_quotas (
    id integer NOT NULL,
    user_id integer NOT NULL,
    quota_date character varying(10),
    used_count integer,
    daily_limit integer,
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: prompt_converter_quotas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompt_converter_quotas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompt_converter_quotas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompt_converter_quotas_id_seq OWNED BY public.prompt_converter_quotas.id;


--
-- Name: prompt_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompt_templates (
    id integer NOT NULL,
    key character varying(64) NOT NULL,
    label character varying(64) NOT NULL,
    kind character varying(16) NOT NULL,
    provider character varying(32),
    template text NOT NULL,
    duration_min integer DEFAULT 1,
    duration_max integer DEFAULT 15,
    duration_default integer DEFAULT 5,
    aspect_ratio character varying(16),
    example_input jsonb,
    example_output text,
    notes text,
    ai_instruction text,
    is_builtin boolean DEFAULT false,
    is_active boolean DEFAULT true,
    display_order integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: prompt_templates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompt_templates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompt_templates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompt_templates_id_seq OWNED BY public.prompt_templates.id;


--
-- Name: prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prompts (
    id integer NOT NULL,
    name character varying(128) NOT NULL,
    stage character varying(32),
    version integer,
    template text NOT NULL,
    variables character varying(512),
    is_active integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: prompts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prompts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prompts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prompts_id_seq OWNED BY public.prompts.id;


--
-- Name: rewrite_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rewrite_jobs (
    id integer NOT NULL,
    user_id integer,
    draft_id integer,
    title character varying(256),
    status character varying(20),
    model character varying(64),
    total integer,
    finished integer,
    per_ep_json jsonb,
    analysis_text text,
    summary_json jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    finished_at timestamp without time zone,
    guidance text DEFAULT ''::text NOT NULL,
    scope_json jsonb,
    batch_evidence jsonb,
    heartbeat_at timestamp without time zone
);


--
-- Name: rewrite_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rewrite_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rewrite_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rewrite_jobs_id_seq OWNED BY public.rewrite_jobs.id;


--
-- Name: runninghub_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runninghub_billing (
    id integer NOT NULL,
    biz_type character varying(32) NOT NULL,
    job_id integer NOT NULL,
    biz_key text DEFAULT ''::text,
    user_id integer,
    attribution_source character varying(40) DEFAULT ''::character varying,
    rh_task_id character varying(128) DEFAULT ''::character varying,
    started_at timestamp without time zone,
    finished_at timestamp without time zone,
    duration_sec double precision DEFAULT '0'::double precision,
    unit character varying(16) DEFAULT '小时'::character varying,
    quantity double precision DEFAULT '0'::double precision,
    unit_price double precision DEFAULT '0'::double precision,
    amount double precision DEFAULT '0'::double precision,
    status character varying(20) DEFAULT 'succeeded'::character varying,
    detail text DEFAULT ''::text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: runninghub_billing_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.runninghub_billing_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: runninghub_billing_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.runninghub_billing_id_seq OWNED BY public.runninghub_billing.id;


--
-- Name: safety_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.safety_reports (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    scope character varying(16),
    overall character varying(16),
    summary text,
    total_issues integer,
    high_count integer,
    medium_count integer,
    low_count integer,
    unresolved_count integer,
    scores_json jsonb,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: safety_reports_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.safety_reports_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safety_reports_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.safety_reports_id_seq OWNED BY public.safety_reports.id;


--
-- Name: safety_risks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.safety_risks (
    id integer NOT NULL,
    report_id integer NOT NULL,
    category character varying(32),
    severity character varying(8),
    keyword character varying(64),
    snippet text,
    chapter_order integer,
    "position" integer,
    reason text,
    suggestion text,
    is_resolved boolean,
    resolved_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: safety_risks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.safety_risks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: safety_risks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.safety_risks_id_seq OWNED BY public.safety_risks.id;


--
-- Name: script_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_analyses (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    scope character varying(20),
    status character varying(20),
    progress_step character varying(50),
    progress_current integer,
    progress_total integer,
    overall_grade character varying(2),
    overall_score integer,
    summary text,
    scores_json json,
    hooks_json json,
    risks_json json,
    audience_json json,
    suggestions_json json,
    metrics_json json,
    llm_raw text,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    report_md text DEFAULT ''::text
);


--
-- Name: script_analyses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.script_analyses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: script_analyses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.script_analyses_id_seq OWNED BY public.script_analyses.id;


--
-- Name: script_chapters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_chapters (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    chapter_order integer NOT NULL,
    title text DEFAULT ''::text,
    summary text DEFAULT ''::text,
    full_text text DEFAULT ''::text,
    word_count integer DEFAULT 0,
    locked integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    version integer DEFAULT 1,
    is_stale integer DEFAULT 0,
    auto_checks jsonb
);


--
-- Name: script_chapters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.script_chapters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: script_chapters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.script_chapters_id_seq OWNED BY public.script_chapters.id;


--
-- Name: script_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_drafts (
    id integer NOT NULL,
    session_id text,
    title text DEFAULT ''::text,
    user_input text,
    outline jsonb DEFAULT '{}'::jsonb,
    outline_locked integer DEFAULT 0,
    status text DEFAULT 'draft'::text,
    chapter_word_target integer DEFAULT 5000,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    original_outline jsonb,
    episode_count integer DEFAULT 3,
    model_provider text DEFAULT 'gemini'::text,
    user_id integer,
    is_favorite boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    deleted_at timestamp without time zone,
    preview_batch_running integer DEFAULT 0,
    auto_batch_job_id integer,
    auto_generated boolean DEFAULT false,
    parent_draft_id integer,
    source_oss_key character varying(512),
    cover_url text DEFAULT ''::text,
    story_bible_json jsonb,
    series_id integer
);


--
-- Name: script_drafts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.script_drafts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: script_drafts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.script_drafts_id_seq OWNED BY public.script_drafts.id;


--
-- Name: script_episode_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_episode_history (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    episode_order integer NOT NULL,
    stage character varying(32) NOT NULL,
    content json NOT NULL,
    version integer NOT NULL,
    created_by character varying(32),
    created_at timestamp without time zone DEFAULT now(),
    job_id integer
);


--
-- Name: script_episode_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.script_episode_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: script_episode_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.script_episode_history_id_seq OWNED BY public.script_episode_history.id;


--
-- Name: script_storyboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_storyboards (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    chapter_order integer NOT NULL,
    shots_json jsonb DEFAULT '[]'::jsonb,
    locked integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    version integer DEFAULT 1,
    updated_at timestamp without time zone DEFAULT now(),
    is_stale integer DEFAULT 0
);


--
-- Name: script_storyboards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.script_storyboards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: script_storyboards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.script_storyboards_id_seq OWNED BY public.script_storyboards.id;


--
-- Name: script_video_prompts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.script_video_prompts (
    id integer NOT NULL,
    draft_id integer NOT NULL,
    chapter_order integer NOT NULL,
    task_index integer NOT NULL,
    duration_s integer DEFAULT 5 NOT NULL,
    source_shot_nos integer[] DEFAULT '{}'::integer[] NOT NULL,
    summary text,
    video_template_key character varying(64),
    video_prompt text,
    image_template_key character varying(64),
    image_prompt text,
    plan_json jsonb,
    status character varying(16) DEFAULT 'draft'::character varying,
    user_edited boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: script_video_prompts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.script_video_prompts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: script_video_prompts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.script_video_prompts_id_seq OWNED BY public.script_video_prompts.id;


--
-- Name: scripts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scripts (
    id integer NOT NULL,
    title character varying(256) NOT NULL,
    genre character varying(64),
    content text NOT NULL,
    license_note character varying(512),
    status character varying(32),
    ragflow_doc_id character varying(128),
    ragflow_dataset_id character varying(128),
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    tags jsonb DEFAULT '[]'::jsonb,
    auto_tagged integer DEFAULT 0,
    tags_confirmed_at timestamp without time zone
);


--
-- Name: scripts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scripts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scripts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scripts_id_seq OWNED BY public.scripts.id;


--
-- Name: snippets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snippets (
    id integer NOT NULL,
    title character varying(128),
    category character varying(32),
    content text NOT NULL,
    tags text[],
    is_public boolean DEFAULT true,
    created_by integer,
    source_draft_id integer,
    usage_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: snippets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.snippets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: snippets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.snippets_id_seq OWNED BY public.snippets.id;


--
-- Name: spawn_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spawn_jobs (
    id integer NOT NULL,
    user_id integer,
    source_draft_id integer,
    title character varying(256),
    intent text,
    mode character varying(16),
    model character varying(64),
    count integer,
    status character varying(20),
    total integer,
    finished integer,
    failed integer,
    dna_json jsonb,
    variants_json jsonb,
    error text,
    created_at timestamp without time zone DEFAULT now(),
    started_at timestamp without time zone,
    finished_at timestamp without time zone,
    total_tokens integer DEFAULT 0 NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    completion_tokens integer DEFAULT 0 NOT NULL,
    cached_tokens integer DEFAULT 0 NOT NULL,
    stage character varying(16) DEFAULT 'legacy'::character varying NOT NULL,
    preview_episodes integer DEFAULT 3 NOT NULL
);


--
-- Name: spawn_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.spawn_jobs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: spawn_jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.spawn_jobs_id_seq OWNED BY public.spawn_jobs.id;


--
-- Name: style_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.style_modules (
    id integer NOT NULL,
    name character varying(128) NOT NULL,
    tags json,
    keywords json,
    language text,
    scenes text,
    weight double precision,
    is_active integer,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: style_modules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.style_modules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: style_modules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.style_modules_id_seq OWNED BY public.style_modules.id;


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    key character varying(64) NOT NULL,
    value text,
    description character varying(256),
    updated_at timestamp without time zone DEFAULT now(),
    updated_by integer
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id integer NOT NULL,
    user_id integer,
    name character varying(64) NOT NULL,
    color character varying(16) DEFAULT '#8b5cf6'::character varying,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;


--
-- Name: tikhub_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tikhub_usage (
    id bigint NOT NULL,
    user_id integer,
    endpoint character varying(128) NOT NULL,
    tikhub_path character varying(256),
    keyword character varying(256),
    ok boolean,
    cached boolean,
    billed boolean,
    status_code integer,
    request_id character varying(64),
    error character varying(512),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: tikhub_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tikhub_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tikhub_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tikhub_usage_id_seq OWNED BY public.tikhub_usage.id;


--
-- Name: upload_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.upload_sessions (
    id text NOT NULL,
    user_id integer NOT NULL,
    filename text NOT NULL,
    total_size bigint NOT NULL,
    sha256 text,
    oss_key text NOT NULL,
    oss_upload_id text,
    upload_kind text DEFAULT 'single'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    parts_completed jsonb DEFAULT '[]'::jsonb NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    expires_at timestamp without time zone NOT NULL,
    completed_at timestamp without time zone
);


--
-- Name: user_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_audit_logs (
    id integer NOT NULL,
    user_id integer,
    action character varying(64),
    resource_type character varying(32),
    resource_id integer,
    ip character varying(45),
    user_agent character varying(512),
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_audit_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_audit_logs_id_seq OWNED BY public.user_audit_logs.id;


--
-- Name: user_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_feedback (
    id integer NOT NULL,
    user_id integer NOT NULL,
    username character varying(64),
    display_name character varying(64),
    content text NOT NULL,
    page_url text,
    status character varying(16) NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_feedback_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_feedback_id_seq OWNED BY public.user_feedback.id;


--
-- Name: user_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_memories (
    id integer NOT NULL,
    user_id integer NOT NULL,
    type character varying(20) NOT NULL,
    scope character varying(20) DEFAULT 'global'::character varying NOT NULL,
    scope_ref character varying(100),
    title character varying(120),
    content text NOT NULL,
    embedding real[],
    embedding_model character varying(64),
    source_conv_id integer,
    source_message_id integer,
    importance integer DEFAULT 5,
    hit_count integer DEFAULT 0,
    pinned boolean DEFAULT false,
    archived boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    last_accessed_at timestamp without time zone,
    expires_at timestamp without time zone
);


--
-- Name: user_memories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_memories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_memories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_memories_id_seq OWNED BY public.user_memories.id;


--
-- Name: user_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_profiles (
    user_id integer NOT NULL,
    preferred_genres text[] DEFAULT ARRAY[]::text[],
    forbidden_topics text[] DEFAULT ARRAY[]::text[],
    preferred_length integer,
    preferred_pace character varying(20),
    style_summary text,
    tone_keywords text[] DEFAULT ARRAY[]::text[],
    writing_quirks jsonb DEFAULT '{}'::jsonb,
    custom_instructions text,
    memory_enabled boolean DEFAULT true,
    total_drafts integer DEFAULT 0,
    total_chats integer DEFAULT 0,
    last_summarized_at timestamp without time zone,
    updated_at timestamp without time zone DEFAULT now(),
    agent_permissions jsonb DEFAULT '{}'::jsonb,
    preferred_model character varying(64)
);


--
-- Name: user_snippets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_snippets (
    id integer NOT NULL,
    user_id integer NOT NULL,
    source_type character varying(20),
    source_id integer,
    category character varying(20),
    content text NOT NULL,
    embedding real[],
    embedding_model character varying(64),
    rating integer,
    tags text[],
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: user_snippets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.user_snippets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: user_snippets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.user_snippets_id_seq OWNED BY public.user_snippets.id;


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username character varying(64) NOT NULL,
    email character varying(128),
    phone character varying(32),
    password_hash character varying(128),
    display_name character varying(64),
    avatar_url character varying(512),
    role character varying(16) DEFAULT 'user'::character varying,
    status character varying(16) DEFAULT 'active'::character varying,
    quota_daily integer DEFAULT 100,
    quota_used_today integer DEFAULT 0,
    quota_reset_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now(),
    last_login_at timestamp without time zone,
    last_login_ip character varying(45),
    theme_config jsonb DEFAULT '{}'::jsonb,
    login_id character varying(64) NOT NULL,
    username_changed_at timestamp without time zone,
    agreement_accepted_at timestamp without time zone,
    feature_flags jsonb DEFAULT '{}'::jsonb,
    feishu_union_id character varying(64),
    feishu_open_id character varying(64),
    feishu_name character varying(64),
    feishu_bound_at timestamp without time zone
);


--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: video_delivery_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_delivery_tags (
    id bigint NOT NULL,
    job_id integer NOT NULL,
    tag character varying(32) NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: video_delivery_tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.video_delivery_tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: video_delivery_tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.video_delivery_tags_id_seq OWNED BY public.video_delivery_tags.id;


--
-- Name: video_download_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_download_logs (
    id bigint NOT NULL,
    job_id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    channel character varying(16)
);


--
-- Name: video_download_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.video_download_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: video_download_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.video_download_logs_id_seq OWNED BY public.video_download_logs.id;


--
-- Name: volc_rate_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.volc_rate_cards (
    id integer NOT NULL,
    model_key character varying(64) NOT NULL,
    label character varying(120),
    unit_price_per_mtoken numeric(20,10),
    note text,
    updated_by integer,
    updated_at timestamp without time zone DEFAULT now(),
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: volc_rate_cards_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.volc_rate_cards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: volc_rate_cards_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.volc_rate_cards_id_seq OWNED BY public.volc_rate_cards.id;


--
-- Name: volc_usage_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.volc_usage_records (
    id integer NOT NULL,
    user_id integer,
    biz_type character varying(32) NOT NULL,
    source character varying(32),
    model_key character varying(64) NOT NULL,
    ep_id character varying(64),
    request_id character varying(96),
    prompt_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    resolution character varying(16),
    duration_sec numeric(10,3),
    ratio character varying(16),
    fps integer,
    has_audio boolean,
    unit_price_per_mtoken numeric(20,10),
    cost_cny numeric(24,12),
    is_estimated boolean,
    draft_id integer,
    extra text,
    created_at timestamp without time zone DEFAULT now(),
    attribution_source character varying(40) DEFAULT ''::character varying NOT NULL
);


--
-- Name: volc_usage_records_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.volc_usage_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: volc_usage_records_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.volc_usage_records_id_seq OWNED BY public.volc_usage_records.id;


--
-- Name: worlds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worlds (
    id integer NOT NULL,
    name character varying(128) NOT NULL,
    era character varying(64),
    location character varying(128),
    setting text,
    rules text,
    tags text[],
    is_public boolean DEFAULT true,
    created_by integer,
    usage_count integer DEFAULT 0,
    created_at timestamp without time zone DEFAULT now(),
    updated_at timestamp without time zone DEFAULT now()
);


--
-- Name: worlds_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.worlds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: worlds_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.worlds_id_seq OWNED BY public.worlds.id;


--
-- Name: agent_approvals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_approvals ALTER COLUMN id SET DEFAULT nextval('public.agent_approvals_id_seq'::regclass);


--
-- Name: agent_artifacts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_artifacts ALTER COLUMN id SET DEFAULT nextval('public.agent_artifacts_id_seq'::regclass);


--
-- Name: agent_attachments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_attachments ALTER COLUMN id SET DEFAULT nextval('public.agent_attachments_id_seq'::regclass);


--
-- Name: agent_batch_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_batch_jobs ALTER COLUMN id SET DEFAULT nextval('public.agent_batch_jobs_id_seq'::regclass);


--
-- Name: agent_conversations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations ALTER COLUMN id SET DEFAULT nextval('public.agent_conversations_id_seq'::regclass);


--
-- Name: agent_document_chapters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_document_chapters ALTER COLUMN id SET DEFAULT nextval('public.agent_document_chapters_id_seq'::regclass);


--
-- Name: agent_documents id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_documents ALTER COLUMN id SET DEFAULT nextval('public.agent_documents_id_seq'::regclass);


--
-- Name: agent_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_images ALTER COLUMN id SET DEFAULT nextval('public.agent_images_id_seq'::regclass);


--
-- Name: agent_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_jobs ALTER COLUMN id SET DEFAULT nextval('public.agent_jobs_id_seq'::regclass);


--
-- Name: agent_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages ALTER COLUMN id SET DEFAULT nextval('public.agent_messages_id_seq'::regclass);


--
-- Name: agent_operations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_operations ALTER COLUMN id SET DEFAULT nextval('public.agent_operations_id_seq'::regclass);


--
-- Name: agent_run_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events ALTER COLUMN id SET DEFAULT nextval('public.agent_run_events_id_seq'::regclass);


--
-- Name: agent_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs ALTER COLUMN id SET DEFAULT nextval('public.agent_runs_id_seq'::regclass);


--
-- Name: announcement_deliveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_deliveries ALTER COLUMN id SET DEFAULT nextval('public.announcement_deliveries_id_seq'::regclass);


--
-- Name: announcement_pushes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_pushes ALTER COLUMN id SET DEFAULT nextval('public.announcement_pushes_id_seq'::regclass);


--
-- Name: announcements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements ALTER COLUMN id SET DEFAULT nextval('public.announcements_id_seq'::regclass);


--
-- Name: api_keys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys ALTER COLUMN id SET DEFAULT nextval('public.api_keys_id_seq'::regclass);


--
-- Name: api_usage_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage_logs ALTER COLUMN id SET DEFAULT nextval('public.api_usage_logs_id_seq'::regclass);


--
-- Name: audio_assets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_assets ALTER COLUMN id SET DEFAULT nextval('public.audio_assets_id_seq'::regclass);


--
-- Name: audio_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_jobs ALTER COLUMN id SET DEFAULT nextval('public.audio_jobs_id_seq'::regclass);


--
-- Name: auto_batch_genres id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_genres ALTER COLUMN id SET DEFAULT nextval('public.auto_batch_genres_id_seq'::regclass);


--
-- Name: auto_batch_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_jobs ALTER COLUMN id SET DEFAULT nextval('public.auto_batch_jobs_id_seq'::regclass);


--
-- Name: auto_batch_transfers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_transfers ALTER COLUMN id SET DEFAULT nextval('public.auto_batch_transfers_id_seq'::regclass);


--
-- Name: chapter_adapt_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_adapt_jobs ALTER COLUMN id SET DEFAULT nextval('public.chapter_adapt_jobs_id_seq'::regclass);


--
-- Name: chapter_adaptations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_adaptations ALTER COLUMN id SET DEFAULT nextval('public.chapter_adaptations_id_seq'::regclass);


--
-- Name: character_consistency_warnings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_consistency_warnings ALTER COLUMN id SET DEFAULT nextval('public.character_consistency_warnings_id_seq'::regclass);


--
-- Name: character_relationships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_relationships ALTER COLUMN id SET DEFAULT nextval('public.character_relationships_id_seq'::regclass);


--
-- Name: characters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters ALTER COLUMN id SET DEFAULT nextval('public.characters_id_seq'::regclass);


--
-- Name: check_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_reports ALTER COLUMN id SET DEFAULT nextval('public.check_reports_id_seq'::regclass);


--
-- Name: clip_assets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_assets ALTER COLUMN id SET DEFAULT nextval('public.clip_assets_id_seq'::regclass);


--
-- Name: clip_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_jobs ALTER COLUMN id SET DEFAULT nextval('public.clip_jobs_id_seq'::regclass);


--
-- Name: content_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_history ALTER COLUMN id SET DEFAULT nextval('public.content_history_id_seq'::regclass);


--
-- Name: critique_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_config ALTER COLUMN id SET DEFAULT nextval('public.critique_config_id_seq'::regclass);


--
-- Name: critique_issues id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_issues ALTER COLUMN id SET DEFAULT nextval('public.critique_issues_id_seq'::regclass);


--
-- Name: critique_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_runs ALTER COLUMN id SET DEFAULT nextval('public.critique_runs_id_seq'::regclass);


--
-- Name: deai_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deai_jobs ALTER COLUMN id SET DEFAULT nextval('public.deai_jobs_id_seq'::regclass);


--
-- Name: desktop_reminders id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desktop_reminders ALTER COLUMN id SET DEFAULT nextval('public.desktop_reminders_id_seq'::regclass);


--
-- Name: draft_batch_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_batch_jobs ALTER COLUMN id SET DEFAULT nextval('public.draft_batch_jobs_id_seq'::regclass);


--
-- Name: draft_batch_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_batch_logs ALTER COLUMN id SET DEFAULT nextval('public.draft_batch_logs_id_seq'::regclass);


--
-- Name: draft_character_images id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_character_images ALTER COLUMN id SET DEFAULT nextval('public.draft_character_images_id_seq'::regclass);


--
-- Name: draft_characters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_characters ALTER COLUMN id SET DEFAULT nextval('public.draft_characters_id_seq'::regclass);


--
-- Name: draft_episode_image_config id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_episode_image_config ALTER COLUMN id SET DEFAULT nextval('public.draft_episode_image_config_id_seq'::regclass);


--
-- Name: draft_extend_configs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_extend_configs ALTER COLUMN id SET DEFAULT nextval('public.draft_extend_configs_id_seq'::regclass);


--
-- Name: draft_image_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_image_tasks ALTER COLUMN id SET DEFAULT nextval('public.draft_image_tasks_id_seq'::regclass);


--
-- Name: draft_read_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_read_state ALTER COLUMN id SET DEFAULT nextval('public.draft_read_state_id_seq'::regclass);


--
-- Name: email_verifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications ALTER COLUMN id SET DEFAULT nextval('public.email_verifications_id_seq'::regclass);


--
-- Name: export_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_jobs ALTER COLUMN id SET DEFAULT nextval('public.export_jobs_id_seq'::regclass);


--
-- Name: factory_dist_targets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_dist_targets ALTER COLUMN id SET DEFAULT nextval('public.factory_dist_targets_id_seq'::regclass);


--
-- Name: factory_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_jobs ALTER COLUMN id SET DEFAULT nextval('public.factory_jobs_id_seq'::regclass);


--
-- Name: factory_pipeline_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_pipeline_runs ALTER COLUMN id SET DEFAULT nextval('public.factory_pipeline_runs_id_seq'::regclass);


--
-- Name: factory_pipelines id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_pipelines ALTER COLUMN id SET DEFAULT nextval('public.factory_pipelines_id_seq'::regclass);


--
-- Name: factory_products id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_products ALTER COLUMN id SET DEFAULT nextval('public.factory_products_id_seq'::regclass);


--
-- Name: factory_stats id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_stats ALTER COLUMN id SET DEFAULT nextval('public.factory_stats_id_seq'::regclass);


--
-- Name: feishu_bitable_syncs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_bitable_syncs ALTER COLUMN id SET DEFAULT nextval('public.feishu_bitable_syncs_id_seq'::regclass);


--
-- Name: feishu_reverse_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_reverse_jobs ALTER COLUMN id SET DEFAULT nextval('public.feishu_reverse_jobs_id_seq'::regclass);


--
-- Name: feishu_row_failures id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_row_failures ALTER COLUMN id SET DEFAULT nextval('public.feishu_row_failures_id_seq'::regclass);


--
-- Name: frontcut_corpus_items id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frontcut_corpus_items ALTER COLUMN id SET DEFAULT nextval('public.frontcut_corpus_items_id_seq'::regclass);


--
-- Name: frontcut_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frontcut_jobs ALTER COLUMN id SET DEFAULT nextval('public.frontcut_jobs_id_seq'::regclass);


--
-- Name: frontcut_voice_refs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frontcut_voice_refs ALTER COLUMN id SET DEFAULT nextval('public.frontcut_voice_refs_id_seq'::regclass);


--
-- Name: generation_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_logs ALTER COLUMN id SET DEFAULT nextval('public.generation_logs_id_seq'::regclass);


--
-- Name: generations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations ALTER COLUMN id SET DEFAULT nextval('public.generations_id_seq'::regclass);


--
-- Name: image_assets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets ALTER COLUMN id SET DEFAULT nextval('public.image_assets_id_seq'::regclass);


--
-- Name: image_billing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_billing ALTER COLUMN id SET DEFAULT nextval('public.image_billing_id_seq'::regclass);


--
-- Name: image_generation_quotas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_generation_quotas ALTER COLUMN id SET DEFAULT nextval('public.image_generation_quotas_id_seq'::regclass);


--
-- Name: image_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs ALTER COLUMN id SET DEFAULT nextval('public.image_jobs_id_seq'::regclass);


--
-- Name: image_prompt_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_presets ALTER COLUMN id SET DEFAULT nextval('public.image_prompt_presets_id_seq'::regclass);


--
-- Name: llm_usage_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage_logs ALTER COLUMN id SET DEFAULT nextval('public.llm_usage_logs_id_seq'::regclass);


--
-- Name: model_channel_health id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_channel_health ALTER COLUMN id SET DEFAULT nextval('public.model_channel_health_id_seq'::regclass);


--
-- Name: novel_video_audio_chunks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_audio_chunks ALTER COLUMN id SET DEFAULT nextval('public.novel_video_audio_chunks_id_seq'::regclass);


--
-- Name: novel_video_bgm id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_bgm ALTER COLUMN id SET DEFAULT nextval('public.novel_video_bgm_id_seq'::regclass);


--
-- Name: novel_video_cover_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_cover_presets ALTER COLUMN id SET DEFAULT nextval('public.novel_video_cover_presets_id_seq'::regclass);


--
-- Name: novel_video_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_jobs ALTER COLUMN id SET DEFAULT nextval('public.novel_video_jobs_id_seq'::regclass);


--
-- Name: novel_video_overlay_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_overlay_presets ALTER COLUMN id SET DEFAULT nextval('public.novel_video_overlay_presets_id_seq'::regclass);


--
-- Name: novel_video_shots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_shots ALTER COLUMN id SET DEFAULT nextval('public.novel_video_shots_id_seq'::regclass);


--
-- Name: novel_video_style_presets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_style_presets ALTER COLUMN id SET DEFAULT nextval('public.novel_video_style_presets_id_seq'::regclass);


--
-- Name: novel_video_voices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_voices ALTER COLUMN id SET DEFAULT nextval('public.novel_video_voices_id_seq'::regclass);


--
-- Name: outline_candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outline_candidates ALTER COLUMN id SET DEFAULT nextval('public.outline_candidates_id_seq'::regclass);


--
-- Name: polish_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polish_jobs ALTER COLUMN id SET DEFAULT nextval('public.polish_jobs_id_seq'::regclass);


--
-- Name: preset_backgrounds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preset_backgrounds ALTER COLUMN id SET DEFAULT nextval('public.preset_backgrounds_id_seq'::regclass);


--
-- Name: project_series id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_series ALTER COLUMN id SET DEFAULT nextval('public.project_series_id_seq'::regclass);


--
-- Name: prompt_converter_quotas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_converter_quotas ALTER COLUMN id SET DEFAULT nextval('public.prompt_converter_quotas_id_seq'::regclass);


--
-- Name: prompt_templates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates ALTER COLUMN id SET DEFAULT nextval('public.prompt_templates_id_seq'::regclass);


--
-- Name: prompts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts ALTER COLUMN id SET DEFAULT nextval('public.prompts_id_seq'::regclass);


--
-- Name: rewrite_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewrite_jobs ALTER COLUMN id SET DEFAULT nextval('public.rewrite_jobs_id_seq'::regclass);


--
-- Name: runninghub_billing id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runninghub_billing ALTER COLUMN id SET DEFAULT nextval('public.runninghub_billing_id_seq'::regclass);


--
-- Name: safety_reports id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports ALTER COLUMN id SET DEFAULT nextval('public.safety_reports_id_seq'::regclass);


--
-- Name: safety_risks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_risks ALTER COLUMN id SET DEFAULT nextval('public.safety_risks_id_seq'::regclass);


--
-- Name: script_analyses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_analyses ALTER COLUMN id SET DEFAULT nextval('public.script_analyses_id_seq'::regclass);


--
-- Name: script_chapters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_chapters ALTER COLUMN id SET DEFAULT nextval('public.script_chapters_id_seq'::regclass);


--
-- Name: script_drafts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_drafts ALTER COLUMN id SET DEFAULT nextval('public.script_drafts_id_seq'::regclass);


--
-- Name: script_episode_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_episode_history ALTER COLUMN id SET DEFAULT nextval('public.script_episode_history_id_seq'::regclass);


--
-- Name: script_storyboards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_storyboards ALTER COLUMN id SET DEFAULT nextval('public.script_storyboards_id_seq'::regclass);


--
-- Name: script_video_prompts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_video_prompts ALTER COLUMN id SET DEFAULT nextval('public.script_video_prompts_id_seq'::regclass);


--
-- Name: scripts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scripts ALTER COLUMN id SET DEFAULT nextval('public.scripts_id_seq'::regclass);


--
-- Name: snippets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snippets ALTER COLUMN id SET DEFAULT nextval('public.snippets_id_seq'::regclass);


--
-- Name: spawn_jobs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spawn_jobs ALTER COLUMN id SET DEFAULT nextval('public.spawn_jobs_id_seq'::regclass);


--
-- Name: style_modules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.style_modules ALTER COLUMN id SET DEFAULT nextval('public.style_modules_id_seq'::regclass);


--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);


--
-- Name: tikhub_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tikhub_usage ALTER COLUMN id SET DEFAULT nextval('public.tikhub_usage_id_seq'::regclass);


--
-- Name: user_audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_audit_logs ALTER COLUMN id SET DEFAULT nextval('public.user_audit_logs_id_seq'::regclass);


--
-- Name: user_feedback id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feedback ALTER COLUMN id SET DEFAULT nextval('public.user_feedback_id_seq'::regclass);


--
-- Name: user_memories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories ALTER COLUMN id SET DEFAULT nextval('public.user_memories_id_seq'::regclass);


--
-- Name: user_snippets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_snippets ALTER COLUMN id SET DEFAULT nextval('public.user_snippets_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Name: video_delivery_tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_delivery_tags ALTER COLUMN id SET DEFAULT nextval('public.video_delivery_tags_id_seq'::regclass);


--
-- Name: video_download_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_download_logs ALTER COLUMN id SET DEFAULT nextval('public.video_download_logs_id_seq'::regclass);


--
-- Name: volc_rate_cards id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volc_rate_cards ALTER COLUMN id SET DEFAULT nextval('public.volc_rate_cards_id_seq'::regclass);


--
-- Name: volc_usage_records id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volc_usage_records ALTER COLUMN id SET DEFAULT nextval('public.volc_usage_records_id_seq'::regclass);


--
-- Name: worlds id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds ALTER COLUMN id SET DEFAULT nextval('public.worlds_id_seq'::regclass);


--
-- Name: checkpoint_blobs checkpoint_blobs_pkey; Type: CONSTRAINT; Schema: agent_ckpt; Owner: -
--

ALTER TABLE ONLY agent_ckpt.checkpoint_blobs
    ADD CONSTRAINT checkpoint_blobs_pkey PRIMARY KEY (thread_id, checkpoint_ns, channel, version);


--
-- Name: checkpoint_migrations checkpoint_migrations_pkey; Type: CONSTRAINT; Schema: agent_ckpt; Owner: -
--

ALTER TABLE ONLY agent_ckpt.checkpoint_migrations
    ADD CONSTRAINT checkpoint_migrations_pkey PRIMARY KEY (v);


--
-- Name: checkpoint_writes checkpoint_writes_pkey; Type: CONSTRAINT; Schema: agent_ckpt; Owner: -
--

ALTER TABLE ONLY agent_ckpt.checkpoint_writes
    ADD CONSTRAINT checkpoint_writes_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx);


--
-- Name: checkpoints checkpoints_pkey; Type: CONSTRAINT; Schema: agent_ckpt; Owner: -
--

ALTER TABLE ONLY agent_ckpt.checkpoints
    ADD CONSTRAINT checkpoints_pkey PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id);


--
-- Name: agent_approvals agent_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_approvals
    ADD CONSTRAINT agent_approvals_pkey PRIMARY KEY (id);


--
-- Name: agent_artifacts agent_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_artifacts
    ADD CONSTRAINT agent_artifacts_pkey PRIMARY KEY (id);


--
-- Name: agent_attachments agent_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_attachments
    ADD CONSTRAINT agent_attachments_pkey PRIMARY KEY (id);


--
-- Name: agent_batch_jobs agent_batch_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_batch_jobs
    ADD CONSTRAINT agent_batch_jobs_pkey PRIMARY KEY (id);


--
-- Name: agent_conversations agent_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_conversations
    ADD CONSTRAINT agent_conversations_pkey PRIMARY KEY (id);


--
-- Name: agent_document_chapters agent_document_chapters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_document_chapters
    ADD CONSTRAINT agent_document_chapters_pkey PRIMARY KEY (id);


--
-- Name: agent_documents agent_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_documents
    ADD CONSTRAINT agent_documents_pkey PRIMARY KEY (id);


--
-- Name: agent_images agent_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_images
    ADD CONSTRAINT agent_images_pkey PRIMARY KEY (id);


--
-- Name: agent_jobs agent_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_jobs
    ADD CONSTRAINT agent_jobs_pkey PRIMARY KEY (id);


--
-- Name: agent_messages agent_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_messages
    ADD CONSTRAINT agent_messages_pkey PRIMARY KEY (id);


--
-- Name: agent_operations agent_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_operations
    ADD CONSTRAINT agent_operations_pkey PRIMARY KEY (id);


--
-- Name: agent_run_events agent_run_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT agent_run_events_pkey PRIMARY KEY (id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: announcement_deliveries announcement_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_deliveries
    ADD CONSTRAINT announcement_deliveries_pkey PRIMARY KEY (id);


--
-- Name: announcement_pushes announcement_pushes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_pushes
    ADD CONSTRAINT announcement_pushes_pkey PRIMARY KEY (id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: api_usage_logs api_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage_logs
    ADD CONSTRAINT api_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: audio_assets audio_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_assets
    ADD CONSTRAINT audio_assets_pkey PRIMARY KEY (id);


--
-- Name: audio_jobs audio_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_jobs
    ADD CONSTRAINT audio_jobs_pkey PRIMARY KEY (id);


--
-- Name: auto_batch_genres auto_batch_genres_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_genres
    ADD CONSTRAINT auto_batch_genres_key_key UNIQUE (key);


--
-- Name: auto_batch_genres auto_batch_genres_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_genres
    ADD CONSTRAINT auto_batch_genres_pkey PRIMARY KEY (id);


--
-- Name: auto_batch_jobs auto_batch_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_jobs
    ADD CONSTRAINT auto_batch_jobs_pkey PRIMARY KEY (id);


--
-- Name: auto_batch_transfers auto_batch_transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auto_batch_transfers
    ADD CONSTRAINT auto_batch_transfers_pkey PRIMARY KEY (id);


--
-- Name: chapter_adapt_jobs chapter_adapt_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_adapt_jobs
    ADD CONSTRAINT chapter_adapt_jobs_pkey PRIMARY KEY (id);


--
-- Name: chapter_adaptations chapter_adaptations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_adaptations
    ADD CONSTRAINT chapter_adaptations_pkey PRIMARY KEY (id);


--
-- Name: character_consistency_warnings character_consistency_warnings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_consistency_warnings
    ADD CONSTRAINT character_consistency_warnings_pkey PRIMARY KEY (id);


--
-- Name: character_relationships character_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_relationships
    ADD CONSTRAINT character_relationships_pkey PRIMARY KEY (id);


--
-- Name: characters characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_pkey PRIMARY KEY (id);


--
-- Name: check_reports check_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.check_reports
    ADD CONSTRAINT check_reports_pkey PRIMARY KEY (id);


--
-- Name: clip_assets clip_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_assets
    ADD CONSTRAINT clip_assets_pkey PRIMARY KEY (id);


--
-- Name: clip_jobs clip_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clip_jobs
    ADD CONSTRAINT clip_jobs_pkey PRIMARY KEY (id);


--
-- Name: content_history content_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_history
    ADD CONSTRAINT content_history_pkey PRIMARY KEY (id);


--
-- Name: critique_config critique_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_config
    ADD CONSTRAINT critique_config_pkey PRIMARY KEY (id);


--
-- Name: critique_issues critique_issues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_issues
    ADD CONSTRAINT critique_issues_pkey PRIMARY KEY (id);


--
-- Name: critique_runs critique_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_runs
    ADD CONSTRAINT critique_runs_pkey PRIMARY KEY (id);


--
-- Name: deai_jobs deai_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deai_jobs
    ADD CONSTRAINT deai_jobs_pkey PRIMARY KEY (id);


--
-- Name: desktop_reminders desktop_reminders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desktop_reminders
    ADD CONSTRAINT desktop_reminders_pkey PRIMARY KEY (id);


--
-- Name: draft_batch_jobs draft_batch_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_batch_jobs
    ADD CONSTRAINT draft_batch_jobs_pkey PRIMARY KEY (id);


--
-- Name: draft_batch_logs draft_batch_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_batch_logs
    ADD CONSTRAINT draft_batch_logs_pkey PRIMARY KEY (id);


--
-- Name: draft_character_images draft_character_images_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_character_images
    ADD CONSTRAINT draft_character_images_pkey PRIMARY KEY (id);


--
-- Name: draft_characters draft_characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_characters
    ADD CONSTRAINT draft_characters_pkey PRIMARY KEY (id);


--
-- Name: draft_episode_image_config draft_episode_image_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_episode_image_config
    ADD CONSTRAINT draft_episode_image_config_pkey PRIMARY KEY (id);


--
-- Name: draft_extend_configs draft_extend_configs_draft_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_extend_configs
    ADD CONSTRAINT draft_extend_configs_draft_id_key UNIQUE (draft_id);


--
-- Name: draft_extend_configs draft_extend_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_extend_configs
    ADD CONSTRAINT draft_extend_configs_pkey PRIMARY KEY (id);


--
-- Name: draft_image_tasks draft_image_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_image_tasks
    ADD CONSTRAINT draft_image_tasks_pkey PRIMARY KEY (id);


--
-- Name: draft_read_state draft_read_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_read_state
    ADD CONSTRAINT draft_read_state_pkey PRIMARY KEY (id);


--
-- Name: draft_tags draft_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_tags
    ADD CONSTRAINT draft_tags_pkey PRIMARY KEY (draft_id, tag_id);


--
-- Name: email_verifications email_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verifications
    ADD CONSTRAINT email_verifications_pkey PRIMARY KEY (id);


--
-- Name: export_jobs export_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_jobs
    ADD CONSTRAINT export_jobs_pkey PRIMARY KEY (id);


--
-- Name: factory_dist_targets factory_dist_targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_dist_targets
    ADD CONSTRAINT factory_dist_targets_pkey PRIMARY KEY (id);


--
-- Name: factory_jobs factory_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_jobs
    ADD CONSTRAINT factory_jobs_pkey PRIMARY KEY (id);


--
-- Name: factory_pipeline_runs factory_pipeline_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_pipeline_runs
    ADD CONSTRAINT factory_pipeline_runs_pkey PRIMARY KEY (id);


--
-- Name: factory_pipelines factory_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_pipelines
    ADD CONSTRAINT factory_pipelines_pkey PRIMARY KEY (id);


--
-- Name: factory_products factory_products_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_products
    ADD CONSTRAINT factory_products_pkey PRIMARY KEY (id);


--
-- Name: factory_stats factory_stats_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_stats
    ADD CONSTRAINT factory_stats_date_key UNIQUE (date);


--
-- Name: factory_stats factory_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.factory_stats
    ADD CONSTRAINT factory_stats_pkey PRIMARY KEY (id);


--
-- Name: feishu_bitable_syncs feishu_bitable_syncs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_bitable_syncs
    ADD CONSTRAINT feishu_bitable_syncs_pkey PRIMARY KEY (id);


--
-- Name: feishu_reverse_jobs feishu_reverse_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_reverse_jobs
    ADD CONSTRAINT feishu_reverse_jobs_pkey PRIMARY KEY (id);


--
-- Name: feishu_row_failures feishu_row_failures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feishu_row_failures
    ADD CONSTRAINT feishu_row_failures_pkey PRIMARY KEY (id);


--
-- Name: frontcut_corpus_items frontcut_corpus_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frontcut_corpus_items
    ADD CONSTRAINT frontcut_corpus_items_pkey PRIMARY KEY (id);


--
-- Name: frontcut_jobs frontcut_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frontcut_jobs
    ADD CONSTRAINT frontcut_jobs_pkey PRIMARY KEY (id);


--
-- Name: frontcut_voice_refs frontcut_voice_refs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frontcut_voice_refs
    ADD CONSTRAINT frontcut_voice_refs_pkey PRIMARY KEY (id);


--
-- Name: generation_logs generation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_logs
    ADD CONSTRAINT generation_logs_pkey PRIMARY KEY (id);


--
-- Name: generations generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generations
    ADD CONSTRAINT generations_pkey PRIMARY KEY (id);


--
-- Name: image_assets image_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_pkey PRIMARY KEY (id);


--
-- Name: image_billing image_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_billing
    ADD CONSTRAINT image_billing_pkey PRIMARY KEY (id);


--
-- Name: image_generation_quotas image_generation_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_generation_quotas
    ADD CONSTRAINT image_generation_quotas_pkey PRIMARY KEY (id);


--
-- Name: image_jobs image_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_pkey PRIMARY KEY (id);


--
-- Name: image_prompt_presets image_prompt_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_prompt_presets
    ADD CONSTRAINT image_prompt_presets_pkey PRIMARY KEY (id);


--
-- Name: llm_usage_logs llm_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.llm_usage_logs
    ADD CONSTRAINT llm_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: model_channel_health model_channel_health_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_channel_health
    ADD CONSTRAINT model_channel_health_pkey PRIMARY KEY (id);


--
-- Name: novel_video_audio_chunks novel_video_audio_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_audio_chunks
    ADD CONSTRAINT novel_video_audio_chunks_pkey PRIMARY KEY (id);


--
-- Name: novel_video_bgm novel_video_bgm_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_bgm
    ADD CONSTRAINT novel_video_bgm_pkey PRIMARY KEY (id);


--
-- Name: novel_video_cover_presets novel_video_cover_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_cover_presets
    ADD CONSTRAINT novel_video_cover_presets_pkey PRIMARY KEY (id);


--
-- Name: novel_video_jobs novel_video_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_jobs
    ADD CONSTRAINT novel_video_jobs_pkey PRIMARY KEY (id);


--
-- Name: novel_video_overlay_presets novel_video_overlay_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_overlay_presets
    ADD CONSTRAINT novel_video_overlay_presets_pkey PRIMARY KEY (id);


--
-- Name: novel_video_shots novel_video_shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_shots
    ADD CONSTRAINT novel_video_shots_pkey PRIMARY KEY (id);


--
-- Name: novel_video_style_presets novel_video_style_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_style_presets
    ADD CONSTRAINT novel_video_style_presets_pkey PRIMARY KEY (id);


--
-- Name: novel_video_voices novel_video_voices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_voices
    ADD CONSTRAINT novel_video_voices_pkey PRIMARY KEY (id);


--
-- Name: outline_candidates outline_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outline_candidates
    ADD CONSTRAINT outline_candidates_pkey PRIMARY KEY (id);


--
-- Name: polish_jobs polish_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.polish_jobs
    ADD CONSTRAINT polish_jobs_pkey PRIMARY KEY (id);


--
-- Name: preset_backgrounds preset_backgrounds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preset_backgrounds
    ADD CONSTRAINT preset_backgrounds_pkey PRIMARY KEY (id);


--
-- Name: project_series project_series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_series
    ADD CONSTRAINT project_series_pkey PRIMARY KEY (id);


--
-- Name: prompt_converter_quotas prompt_converter_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_converter_quotas
    ADD CONSTRAINT prompt_converter_quotas_pkey PRIMARY KEY (id);


--
-- Name: prompt_templates prompt_templates_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates
    ADD CONSTRAINT prompt_templates_key_key UNIQUE (key);


--
-- Name: prompt_templates prompt_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompt_templates
    ADD CONSTRAINT prompt_templates_pkey PRIMARY KEY (id);


--
-- Name: prompts prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);


--
-- Name: rewrite_jobs rewrite_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewrite_jobs
    ADD CONSTRAINT rewrite_jobs_pkey PRIMARY KEY (id);


--
-- Name: runninghub_billing runninghub_billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runninghub_billing
    ADD CONSTRAINT runninghub_billing_pkey PRIMARY KEY (id);


--
-- Name: safety_reports safety_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_pkey PRIMARY KEY (id);


--
-- Name: safety_risks safety_risks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_risks
    ADD CONSTRAINT safety_risks_pkey PRIMARY KEY (id);


--
-- Name: script_analyses script_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_analyses
    ADD CONSTRAINT script_analyses_pkey PRIMARY KEY (id);


--
-- Name: script_chapters script_chapters_draft_id_chapter_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_chapters
    ADD CONSTRAINT script_chapters_draft_id_chapter_order_key UNIQUE (draft_id, chapter_order);


--
-- Name: script_chapters script_chapters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_chapters
    ADD CONSTRAINT script_chapters_pkey PRIMARY KEY (id);


--
-- Name: script_drafts script_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_drafts
    ADD CONSTRAINT script_drafts_pkey PRIMARY KEY (id);


--
-- Name: script_episode_history script_episode_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_episode_history
    ADD CONSTRAINT script_episode_history_pkey PRIMARY KEY (id);


--
-- Name: script_storyboards script_storyboards_draft_id_chapter_order_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_storyboards
    ADD CONSTRAINT script_storyboards_draft_id_chapter_order_key UNIQUE (draft_id, chapter_order);


--
-- Name: script_storyboards script_storyboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_storyboards
    ADD CONSTRAINT script_storyboards_pkey PRIMARY KEY (id);


--
-- Name: script_video_prompts script_video_prompts_draft_id_chapter_order_task_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_video_prompts
    ADD CONSTRAINT script_video_prompts_draft_id_chapter_order_task_index_key UNIQUE (draft_id, chapter_order, task_index);


--
-- Name: script_video_prompts script_video_prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_video_prompts
    ADD CONSTRAINT script_video_prompts_pkey PRIMARY KEY (id);


--
-- Name: scripts scripts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scripts
    ADD CONSTRAINT scripts_pkey PRIMARY KEY (id);


--
-- Name: snippets snippets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snippets
    ADD CONSTRAINT snippets_pkey PRIMARY KEY (id);


--
-- Name: spawn_jobs spawn_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spawn_jobs
    ADD CONSTRAINT spawn_jobs_pkey PRIMARY KEY (id);


--
-- Name: style_modules style_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.style_modules
    ADD CONSTRAINT style_modules_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_user_id_name_key UNIQUE (user_id, name);


--
-- Name: tikhub_usage tikhub_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tikhub_usage
    ADD CONSTRAINT tikhub_usage_pkey PRIMARY KEY (id);


--
-- Name: upload_sessions upload_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_pkey PRIMARY KEY (id);


--
-- Name: chapter_adaptations uq_adapt_draft_kind_chapter; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chapter_adaptations
    ADD CONSTRAINT uq_adapt_draft_kind_chapter UNIQUE (draft_id, kind, chapter_order);


--
-- Name: agent_approvals uq_agent_approvals_point; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_approvals
    ADD CONSTRAINT uq_agent_approvals_point UNIQUE (run_id, interrupt_id, idx);


--
-- Name: agent_run_events uq_agent_run_events_run_seq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_events
    ADD CONSTRAINT uq_agent_run_events_run_seq UNIQUE (run_id, seq);


--
-- Name: draft_read_state uq_draft_read_state; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_read_state
    ADD CONSTRAINT uq_draft_read_state UNIQUE (user_id, draft_id, stream);


--
-- Name: model_channel_health uq_model_channel; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.model_channel_health
    ADD CONSTRAINT uq_model_channel UNIQUE (provider, model, channel);


--
-- Name: runninghub_billing uq_rh_billing_biz_job; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runninghub_billing
    ADD CONSTRAINT uq_rh_billing_biz_job UNIQUE (biz_type, job_id);


--
-- Name: video_delivery_tags uq_video_tag_job_tag; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_delivery_tags
    ADD CONSTRAINT uq_video_tag_job_tag UNIQUE (job_id, tag);


--
-- Name: user_audit_logs user_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_audit_logs
    ADD CONSTRAINT user_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: user_feedback user_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feedback
    ADD CONSTRAINT user_feedback_pkey PRIMARY KEY (id);


--
-- Name: user_memories user_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_pkey PRIMARY KEY (id);


--
-- Name: user_profiles user_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: user_snippets user_snippets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_snippets
    ADD CONSTRAINT user_snippets_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);


--
-- Name: video_delivery_tags video_delivery_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_delivery_tags
    ADD CONSTRAINT video_delivery_tags_pkey PRIMARY KEY (id);


--
-- Name: video_download_logs video_download_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_download_logs
    ADD CONSTRAINT video_download_logs_pkey PRIMARY KEY (id);


--
-- Name: volc_rate_cards volc_rate_cards_model_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volc_rate_cards
    ADD CONSTRAINT volc_rate_cards_model_key_key UNIQUE (model_key);


--
-- Name: volc_rate_cards volc_rate_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volc_rate_cards
    ADD CONSTRAINT volc_rate_cards_pkey PRIMARY KEY (id);


--
-- Name: volc_usage_records volc_usage_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.volc_usage_records
    ADD CONSTRAINT volc_usage_records_pkey PRIMARY KEY (id);


--
-- Name: worlds worlds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_pkey PRIMARY KEY (id);


--
-- Name: checkpoint_blobs_thread_id_idx; Type: INDEX; Schema: agent_ckpt; Owner: -
--

CREATE INDEX checkpoint_blobs_thread_id_idx ON agent_ckpt.checkpoint_blobs USING btree (thread_id);


--
-- Name: checkpoint_writes_thread_id_idx; Type: INDEX; Schema: agent_ckpt; Owner: -
--

CREATE INDEX checkpoint_writes_thread_id_idx ON agent_ckpt.checkpoint_writes USING btree (thread_id);


--
-- Name: checkpoints_thread_id_idx; Type: INDEX; Schema: agent_ckpt; Owner: -
--

CREATE INDEX checkpoints_thread_id_idx ON agent_ckpt.checkpoints USING btree (thread_id);


--
-- Name: idx_announcements_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_announcements_active ON public.announcements USING btree (active, start_at, end_at);


--
-- Name: idx_api_usage_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_usage_date ON public.api_usage_logs USING btree (created_at DESC);


--
-- Name: idx_api_usage_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_usage_user ON public.api_usage_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_audit_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_user ON public.user_audit_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_candidates_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_candidates_draft ON public.outline_candidates USING btree (draft_id, batch_id DESC);


--
-- Name: idx_chap_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_chap_draft ON public.script_chapters USING btree (draft_id);


--
-- Name: idx_draft_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_draft_tags_tag ON public.draft_tags USING btree (tag_id);


--
-- Name: idx_drafts_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_deleted ON public.script_drafts USING btree (is_deleted, deleted_at);


--
-- Name: idx_drafts_favorite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_favorite ON public.script_drafts USING btree (user_id, is_favorite);


--
-- Name: idx_drafts_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_session ON public.script_drafts USING btree (session_id);


--
-- Name: idx_drafts_title_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_title_search ON public.script_drafts USING gin (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(user_input, ''::text))));


--
-- Name: idx_drafts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_drafts_user ON public.script_drafts USING btree (user_id);


--
-- Name: idx_factory_jobs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_jobs_created_at ON public.factory_jobs USING btree (created_at);


--
-- Name: idx_factory_jobs_job_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_jobs_job_type ON public.factory_jobs USING btree (job_type);


--
-- Name: idx_factory_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_jobs_status ON public.factory_jobs USING btree (status);


--
-- Name: idx_factory_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_jobs_user_id ON public.factory_jobs USING btree (user_id);


--
-- Name: idx_factory_products_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_products_draft_id ON public.factory_products USING btree (draft_id);


--
-- Name: idx_factory_products_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_products_job_id ON public.factory_products USING btree (job_id);


--
-- Name: idx_factory_products_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_products_parent_id ON public.factory_products USING btree (parent_id);


--
-- Name: idx_factory_products_product_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_products_product_type ON public.factory_products USING btree (product_type);


--
-- Name: idx_factory_products_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_products_user_id ON public.factory_products USING btree (user_id);


--
-- Name: idx_factory_stats_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_factory_stats_date ON public.factory_stats USING btree (date);


--
-- Name: idx_history_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_history_draft ON public.content_history USING btree (draft_id, stage, chapter_order, created_at DESC);


--
-- Name: idx_logs_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_logs_draft ON public.generation_logs USING btree (draft_id);


--
-- Name: idx_script_drafts_auto_batch_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_script_drafts_auto_batch_job_id ON public.script_drafts USING btree (auto_batch_job_id);


--
-- Name: idx_snippets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_snippets_category ON public.snippets USING btree (category);


--
-- Name: idx_tags_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_user ON public.tags USING btree (user_id);


--
-- Name: idx_upload_sessions_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_sessions_expires ON public.upload_sessions USING btree (expires_at) WHERE (status = 'pending'::text);


--
-- Name: idx_upload_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_upload_sessions_user ON public.upload_sessions USING btree (user_id, status);


--
-- Name: idx_users_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_users_username ON public.users USING btree (username);


--
-- Name: ix_agent_approvals_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_approvals_run_id ON public.agent_approvals USING btree (run_id);


--
-- Name: ix_agent_approvals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_approvals_status ON public.agent_approvals USING btree (status);


--
-- Name: ix_agent_artifacts_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_artifacts_conv ON public.agent_artifacts USING btree (conversation_id);


--
-- Name: ix_agent_artifacts_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_artifacts_conversation_id ON public.agent_artifacts USING btree (conversation_id);


--
-- Name: ix_agent_artifacts_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_artifacts_message_id ON public.agent_artifacts USING btree (message_id);


--
-- Name: ix_agent_artifacts_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_artifacts_msg ON public.agent_artifacts USING btree (message_id);


--
-- Name: ix_agent_artifacts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_artifacts_user ON public.agent_artifacts USING btree (user_id);


--
-- Name: ix_agent_artifacts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_artifacts_user_id ON public.agent_artifacts USING btree (user_id);


--
-- Name: ix_agent_attachments_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_attachments_conv ON public.agent_attachments USING btree (conversation_id);


--
-- Name: ix_agent_attachments_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_attachments_conversation_id ON public.agent_attachments USING btree (conversation_id);


--
-- Name: ix_agent_attachments_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_attachments_message_id ON public.agent_attachments USING btree (message_id);


--
-- Name: ix_agent_attachments_msg; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_attachments_msg ON public.agent_attachments USING btree (message_id);


--
-- Name: ix_agent_attachments_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_attachments_user ON public.agent_attachments USING btree (user_id);


--
-- Name: ix_agent_attachments_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_attachments_user_id ON public.agent_attachments USING btree (user_id);


--
-- Name: ix_agent_batch_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_batch_jobs_user_id ON public.agent_batch_jobs USING btree (user_id);


--
-- Name: ix_agent_conversations_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_conversations_draft_id ON public.agent_conversations USING btree (draft_id);


--
-- Name: ix_agent_conversations_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_conversations_source ON public.agent_conversations USING btree (source);


--
-- Name: ix_agent_conversations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_conversations_user_id ON public.agent_conversations USING btree (user_id);


--
-- Name: ix_agent_document_chapters_document_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_document_chapters_document_id ON public.agent_document_chapters USING btree (document_id);


--
-- Name: ix_agent_documents_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_documents_conversation_id ON public.agent_documents USING btree (conversation_id);


--
-- Name: ix_agent_documents_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_documents_draft_id ON public.agent_documents USING btree (draft_id);


--
-- Name: ix_agent_documents_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_documents_user_id ON public.agent_documents USING btree (user_id);


--
-- Name: ix_agent_images_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_images_conversation_id ON public.agent_images USING btree (conversation_id);


--
-- Name: ix_agent_images_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_images_message_id ON public.agent_images USING btree (message_id);


--
-- Name: ix_agent_images_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_images_user_id ON public.agent_images USING btree (user_id);


--
-- Name: ix_agent_jobs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_jobs_draft_id ON public.agent_jobs USING btree (draft_id);


--
-- Name: ix_agent_jobs_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_jobs_kind ON public.agent_jobs USING btree (kind);


--
-- Name: ix_agent_jobs_lease_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_jobs_lease_expires_at ON public.agent_jobs USING btree (lease_expires_at);


--
-- Name: ix_agent_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_jobs_status ON public.agent_jobs USING btree (status);


--
-- Name: ix_agent_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_jobs_user_id ON public.agent_jobs USING btree (user_id);


--
-- Name: ix_agent_messages_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_messages_conversation_id ON public.agent_messages USING btree (conversation_id);


--
-- Name: ix_agent_messages_group_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_messages_group_id ON public.agent_messages USING btree (group_id);


--
-- Name: ix_agent_ops_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_ops_conv ON public.agent_operations USING btree (conversation_id, status);


--
-- Name: ix_agent_ops_user_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_ops_user_pending ON public.agent_operations USING btree (user_id, status) WHERE ((status)::text = 'pending'::text);


--
-- Name: ix_agent_run_events_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_run_events_run_id ON public.agent_run_events USING btree (run_id);


--
-- Name: ix_agent_runs_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs_conversation_id ON public.agent_runs USING btree (conversation_id);


--
-- Name: ix_agent_runs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs_created_at ON public.agent_runs USING btree (created_at);


--
-- Name: ix_agent_runs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs_draft_id ON public.agent_runs USING btree (draft_id);


--
-- Name: ix_agent_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs_status ON public.agent_runs USING btree (status);


--
-- Name: ix_agent_runs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_agent_runs_user_id ON public.agent_runs USING btree (user_id);


--
-- Name: ix_announcement_deliveries_push_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_announcement_deliveries_push_id ON public.announcement_deliveries USING btree (push_id);


--
-- Name: ix_announcement_deliveries_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_announcement_deliveries_status ON public.announcement_deliveries USING btree (status);


--
-- Name: ix_announcement_deliveries_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_announcement_deliveries_user_id ON public.announcement_deliveries USING btree (user_id);


--
-- Name: ix_announcement_pushes_announcement_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_announcement_pushes_announcement_id ON public.announcement_pushes USING btree (announcement_id);


--
-- Name: ix_announcement_pushes_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_announcement_pushes_created_at ON public.announcement_pushes USING btree (created_at);


--
-- Name: ix_announcement_pushes_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_announcement_pushes_created_by ON public.announcement_pushes USING btree (created_by);


--
-- Name: ix_api_keys_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_api_keys_user_id ON public.api_keys USING btree (user_id);


--
-- Name: ix_audio_assets_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audio_assets_expires_at ON public.audio_assets USING btree (expires_at);


--
-- Name: ix_audio_assets_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audio_assets_job_id ON public.audio_assets USING btree (job_id);


--
-- Name: ix_audio_assets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audio_assets_user_id ON public.audio_assets USING btree (user_id);


--
-- Name: ix_audio_jobs_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audio_jobs_expires_at ON public.audio_jobs USING btree (expires_at);


--
-- Name: ix_audio_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audio_jobs_status ON public.audio_jobs USING btree (status);


--
-- Name: ix_audio_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_audio_jobs_user_id ON public.audio_jobs USING btree (user_id);


--
-- Name: ix_auto_batch_jobs_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auto_batch_jobs_created_by ON public.auto_batch_jobs USING btree (created_by);


--
-- Name: ix_auto_batch_transfers_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auto_batch_transfers_draft_id ON public.auto_batch_transfers USING btree (draft_id);


--
-- Name: ix_auto_batch_transfers_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auto_batch_transfers_job_id ON public.auto_batch_transfers USING btree (job_id);


--
-- Name: ix_auto_batch_transfers_target_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auto_batch_transfers_target_user_id ON public.auto_batch_transfers USING btree (target_user_id);


--
-- Name: ix_chapter_adapt_jobs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_chapter_adapt_jobs_draft_id ON public.chapter_adapt_jobs USING btree (draft_id);


--
-- Name: ix_chapter_adapt_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_chapter_adapt_jobs_user_id ON public.chapter_adapt_jobs USING btree (user_id);


--
-- Name: ix_chapter_adaptations_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_chapter_adaptations_draft_id ON public.chapter_adaptations USING btree (draft_id);


--
-- Name: ix_chapter_adaptations_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_chapter_adaptations_kind ON public.chapter_adaptations USING btree (kind);


--
-- Name: ix_character_consistency_warnings_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_character_consistency_warnings_draft_id ON public.character_consistency_warnings USING btree (draft_id);


--
-- Name: ix_character_relationships_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_character_relationships_draft_id ON public.character_relationships USING btree (draft_id);


--
-- Name: ix_characters_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_characters_draft_id ON public.characters USING btree (draft_id);


--
-- Name: ix_check_reports_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_check_reports_draft ON public.check_reports USING btree (draft_id, id);


--
-- Name: ix_clip_assets_batch_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_assets_batch_id ON public.clip_assets USING btree (batch_id);


--
-- Name: ix_clip_assets_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_assets_category ON public.clip_assets USING btree (category);


--
-- Name: ix_clip_assets_is_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_assets_is_public ON public.clip_assets USING btree (is_public);


--
-- Name: ix_clip_assets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_assets_status ON public.clip_assets USING btree (status);


--
-- Name: ix_clip_assets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_assets_user_id ON public.clip_assets USING btree (user_id);


--
-- Name: ix_clip_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_jobs_status ON public.clip_jobs USING btree (status);


--
-- Name: ix_clip_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_clip_jobs_user_id ON public.clip_jobs USING btree (user_id);


--
-- Name: ix_critique_issues_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_critique_issues_run_id ON public.critique_issues USING btree (run_id);


--
-- Name: ix_critique_runs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_critique_runs_draft_id ON public.critique_runs USING btree (draft_id);


--
-- Name: ix_critique_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_critique_runs_status ON public.critique_runs USING btree (status);


--
-- Name: ix_critique_runs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_critique_runs_user_id ON public.critique_runs USING btree (user_id);


--
-- Name: ix_deai_jobs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_deai_jobs_draft_id ON public.deai_jobs USING btree (draft_id);


--
-- Name: ix_deai_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_deai_jobs_user_id ON public.deai_jobs USING btree (user_id);


--
-- Name: ix_desktop_reminders_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_desktop_reminders_status ON public.desktop_reminders USING btree (status);


--
-- Name: ix_desktop_reminders_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_desktop_reminders_user_id ON public.desktop_reminders USING btree (user_id);


--
-- Name: ix_draft_batch_jobs_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_jobs_draft ON public.draft_batch_jobs USING btree (draft_id);


--
-- Name: ix_draft_batch_jobs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_jobs_draft_id ON public.draft_batch_jobs USING btree (draft_id);


--
-- Name: ix_draft_batch_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_jobs_status ON public.draft_batch_jobs USING btree (status);


--
-- Name: ix_draft_batch_jobs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_jobs_user ON public.draft_batch_jobs USING btree (user_id);


--
-- Name: ix_draft_batch_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_jobs_user_id ON public.draft_batch_jobs USING btree (user_id);


--
-- Name: ix_draft_batch_logs_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_logs_job ON public.draft_batch_logs USING btree (job_id);


--
-- Name: ix_draft_batch_logs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_batch_logs_job_id ON public.draft_batch_logs USING btree (job_id);


--
-- Name: ix_draft_character_images_character_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_character_images_character_id ON public.draft_character_images USING btree (character_id);


--
-- Name: ix_draft_characters_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_characters_draft_id ON public.draft_characters USING btree (draft_id);


--
-- Name: ix_draft_episode_image_config_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_episode_image_config_draft_id ON public.draft_episode_image_config USING btree (draft_id);


--
-- Name: ix_draft_image_tasks_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_image_tasks_draft_id ON public.draft_image_tasks USING btree (draft_id);


--
-- Name: ix_draft_image_tasks_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_image_tasks_user_id ON public.draft_image_tasks USING btree (user_id);


--
-- Name: ix_draft_read_state_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_read_state_draft_id ON public.draft_read_state USING btree (draft_id);


--
-- Name: ix_draft_read_state_user_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_read_state_user_draft ON public.draft_read_state USING btree (user_id, draft_id);


--
-- Name: ix_draft_read_state_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_draft_read_state_user_id ON public.draft_read_state USING btree (user_id);


--
-- Name: ix_email_verifications_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_email_verifications_email ON public.email_verifications USING btree (email);


--
-- Name: ix_export_jobs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_export_jobs_draft_id ON public.export_jobs USING btree (draft_id);


--
-- Name: ix_export_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_export_jobs_status ON public.export_jobs USING btree (status);


--
-- Name: ix_export_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_export_jobs_user_id ON public.export_jobs USING btree (user_id);


--
-- Name: ix_factory_dist_targets_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_dist_targets_id ON public.factory_dist_targets USING btree (id);


--
-- Name: ix_factory_dist_targets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_dist_targets_user_id ON public.factory_dist_targets USING btree (user_id);


--
-- Name: ix_factory_pipeline_runs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_pipeline_runs_created_at ON public.factory_pipeline_runs USING btree (created_at);


--
-- Name: ix_factory_pipeline_runs_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_pipeline_runs_id ON public.factory_pipeline_runs USING btree (id);


--
-- Name: ix_factory_pipeline_runs_pipeline_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_pipeline_runs_pipeline_id ON public.factory_pipeline_runs USING btree (pipeline_id);


--
-- Name: ix_factory_pipeline_runs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_pipeline_runs_user_id ON public.factory_pipeline_runs USING btree (user_id);


--
-- Name: ix_factory_pipelines_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_pipelines_id ON public.factory_pipelines USING btree (id);


--
-- Name: ix_factory_pipelines_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_factory_pipelines_user_id ON public.factory_pipelines USING btree (user_id);


--
-- Name: ix_feishu_bitable_syncs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_feishu_bitable_syncs_user_id ON public.feishu_bitable_syncs USING btree (user_id);


--
-- Name: ix_feishu_reverse_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_feishu_reverse_jobs_status ON public.feishu_reverse_jobs USING btree (status);


--
-- Name: ix_feishu_reverse_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_feishu_reverse_jobs_user_id ON public.feishu_reverse_jobs USING btree (user_id);


--
-- Name: ix_feishu_row_failures_cfg_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_feishu_row_failures_cfg_id ON public.feishu_row_failures USING btree (cfg_id);


--
-- Name: ix_feishu_row_failures_record_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_feishu_row_failures_record_id ON public.feishu_row_failures USING btree (record_id);


--
-- Name: ix_feishu_row_failures_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_feishu_row_failures_user_id ON public.feishu_row_failures USING btree (user_id);


--
-- Name: ix_frontcut_corpus_auto_tagged; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_corpus_auto_tagged ON public.frontcut_corpus_items USING btree (auto_tagged);


--
-- Name: ix_frontcut_corpus_content_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_corpus_content_rating ON public.frontcut_corpus_items USING btree (content_rating);


--
-- Name: ix_frontcut_corpus_items_is_preset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_corpus_items_is_preset ON public.frontcut_corpus_items USING btree (is_preset);


--
-- Name: ix_frontcut_corpus_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_corpus_items_status ON public.frontcut_corpus_items USING btree (status);


--
-- Name: ix_frontcut_corpus_items_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_corpus_items_user_id ON public.frontcut_corpus_items USING btree (user_id);


--
-- Name: ix_frontcut_corpus_protagonist_gender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_corpus_protagonist_gender ON public.frontcut_corpus_items USING btree (protagonist_gender);


--
-- Name: ix_frontcut_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_jobs_status ON public.frontcut_jobs USING btree (status);


--
-- Name: ix_frontcut_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_jobs_user_id ON public.frontcut_jobs USING btree (user_id);


--
-- Name: ix_frontcut_voice_refs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_frontcut_voice_refs_user_id ON public.frontcut_voice_refs USING btree (user_id);


--
-- Name: ix_generations_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_generations_session_id ON public.generations USING btree (session_id);


--
-- Name: ix_image_assets_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_assets_expires_at ON public.image_assets USING btree (expires_at);


--
-- Name: ix_image_assets_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_assets_job_id ON public.image_assets USING btree (job_id);


--
-- Name: ix_image_assets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_assets_user_id ON public.image_assets USING btree (user_id);


--
-- Name: ix_image_billing_amount; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_billing_amount ON public.image_billing USING btree (amount);


--
-- Name: ix_image_billing_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_billing_created_at ON public.image_billing USING btree (created_at);


--
-- Name: ix_image_billing_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_image_billing_job_id ON public.image_billing USING btree (job_id);


--
-- Name: ix_image_billing_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_billing_user_id ON public.image_billing USING btree (user_id);


--
-- Name: ix_image_generation_quotas_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_generation_quotas_date ON public.image_generation_quotas USING btree (quota_date);


--
-- Name: ix_image_generation_quotas_quota_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_generation_quotas_quota_date ON public.image_generation_quotas USING btree (quota_date);


--
-- Name: ix_image_generation_quotas_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_generation_quotas_user ON public.image_generation_quotas USING btree (user_id);


--
-- Name: ix_image_generation_quotas_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_generation_quotas_user_id ON public.image_generation_quotas USING btree (user_id);


--
-- Name: ix_image_jobs_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_jobs_expires_at ON public.image_jobs USING btree (expires_at);


--
-- Name: ix_image_jobs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_jobs_status ON public.image_jobs USING btree (status);


--
-- Name: ix_image_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_image_jobs_user_id ON public.image_jobs USING btree (user_id);


--
-- Name: ix_llm_usage_logs_attr_src; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_attr_src ON public.llm_usage_logs USING btree (attribution_source);


--
-- Name: ix_llm_usage_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_created_at ON public.llm_usage_logs USING btree (created_at);


--
-- Name: ix_llm_usage_logs_duration_ms; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_duration_ms ON public.llm_usage_logs USING btree (duration_ms);


--
-- Name: ix_llm_usage_logs_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_id ON public.llm_usage_logs USING btree (id);


--
-- Name: ix_llm_usage_logs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_job_id ON public.llm_usage_logs USING btree (job_id);


--
-- Name: ix_llm_usage_logs_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_stage ON public.llm_usage_logs USING btree (stage);


--
-- Name: ix_llm_usage_logs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_llm_usage_logs_user_id ON public.llm_usage_logs USING btree (user_id);


--
-- Name: ix_mch_checked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mch_checked_at ON public.model_channel_health USING btree (checked_at);


--
-- Name: ix_mch_model; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mch_model ON public.model_channel_health USING btree (model);


--
-- Name: ix_mch_provider; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_mch_provider ON public.model_channel_health USING btree (provider);


--
-- Name: ix_novel_video_audio_chunks_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_audio_chunks_job_id ON public.novel_video_audio_chunks USING btree (job_id);


--
-- Name: ix_novel_video_bgm_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_bgm_category ON public.novel_video_bgm USING btree (category);


--
-- Name: ix_novel_video_bgm_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_bgm_user_id ON public.novel_video_bgm USING btree (user_id);


--
-- Name: ix_novel_video_jobs_feishu_record_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_jobs_feishu_record_id ON public.novel_video_jobs USING btree (feishu_record_id);


--
-- Name: ix_novel_video_jobs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_jobs_source ON public.novel_video_jobs USING btree (source);


--
-- Name: ix_novel_video_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_jobs_user_id ON public.novel_video_jobs USING btree (user_id);


--
-- Name: ix_novel_video_overlay_presets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_overlay_presets_user_id ON public.novel_video_overlay_presets USING btree (user_id);


--
-- Name: ix_novel_video_shots_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_shots_job_id ON public.novel_video_shots USING btree (job_id);


--
-- Name: ix_novel_video_style_presets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_style_presets_user_id ON public.novel_video_style_presets USING btree (user_id);


--
-- Name: ix_novel_video_voices_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_novel_video_voices_user_id ON public.novel_video_voices USING btree (user_id);


--
-- Name: ix_nv_cover_presets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_nv_cover_presets_user ON public.novel_video_cover_presets USING btree (user_id);


--
-- Name: ix_polish_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_polish_jobs_user_id ON public.polish_jobs USING btree (user_id);


--
-- Name: ix_prompt_converter_quotas_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompt_converter_quotas_date ON public.prompt_converter_quotas USING btree (quota_date);


--
-- Name: ix_prompt_converter_quotas_quota_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompt_converter_quotas_quota_date ON public.prompt_converter_quotas USING btree (quota_date);


--
-- Name: ix_prompt_converter_quotas_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompt_converter_quotas_user ON public.prompt_converter_quotas USING btree (user_id);


--
-- Name: ix_prompt_converter_quotas_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompt_converter_quotas_user_id ON public.prompt_converter_quotas USING btree (user_id);


--
-- Name: ix_prompt_templates_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompt_templates_active ON public.prompt_templates USING btree (is_active);


--
-- Name: ix_prompt_templates_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompt_templates_kind ON public.prompt_templates USING btree (kind);


--
-- Name: ix_prompts_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_prompts_stage ON public.prompts USING btree (stage);


--
-- Name: ix_rewrite_jobs_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_rewrite_jobs_draft_id ON public.rewrite_jobs USING btree (draft_id);


--
-- Name: ix_rewrite_jobs_heartbeat_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_rewrite_jobs_heartbeat_at ON public.rewrite_jobs USING btree (heartbeat_at);


--
-- Name: ix_rewrite_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_rewrite_jobs_user_id ON public.rewrite_jobs USING btree (user_id);


--
-- Name: ix_rh_billing_biz_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_rh_billing_biz_type ON public.runninghub_billing USING btree (biz_type);


--
-- Name: ix_rh_billing_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_rh_billing_created ON public.runninghub_billing USING btree (created_at);


--
-- Name: ix_rh_billing_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_rh_billing_user ON public.runninghub_billing USING btree (user_id);


--
-- Name: ix_safety_reports_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_safety_reports_draft ON public.safety_reports USING btree (draft_id);


--
-- Name: ix_safety_reports_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_safety_reports_draft_id ON public.safety_reports USING btree (draft_id);


--
-- Name: ix_safety_risks_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_safety_risks_report ON public.safety_risks USING btree (report_id);


--
-- Name: ix_safety_risks_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_safety_risks_report_id ON public.safety_risks USING btree (report_id);


--
-- Name: ix_script_analyses_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_script_analyses_draft_id ON public.script_analyses USING btree (draft_id);


--
-- Name: ix_script_episode_history_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_script_episode_history_draft_id ON public.script_episode_history USING btree (draft_id);


--
-- Name: ix_script_episode_history_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_script_episode_history_job_id ON public.script_episode_history USING btree (job_id);


--
-- Name: ix_scripts_genre; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_scripts_genre ON public.scripts USING btree (genre);


--
-- Name: ix_spawn_jobs_source_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_spawn_jobs_source_draft_id ON public.spawn_jobs USING btree (source_draft_id);


--
-- Name: ix_spawn_jobs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_spawn_jobs_user_id ON public.spawn_jobs USING btree (user_id);


--
-- Name: ix_tikhub_usage_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tikhub_usage_created_at ON public.tikhub_usage USING btree (created_at);


--
-- Name: ix_tikhub_usage_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tikhub_usage_endpoint ON public.tikhub_usage USING btree (endpoint);


--
-- Name: ix_tikhub_usage_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_tikhub_usage_user_id ON public.tikhub_usage USING btree (user_id);


--
-- Name: ix_user_feedback_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_feedback_created_at ON public.user_feedback USING btree (created_at);


--
-- Name: ix_user_feedback_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_feedback_status ON public.user_feedback USING btree (status);


--
-- Name: ix_user_feedback_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_feedback_user_id ON public.user_feedback USING btree (user_id);


--
-- Name: ix_user_memories_user_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_memories_user_archived ON public.user_memories USING btree (user_id, archived);


--
-- Name: ix_user_memories_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_memories_user_type ON public.user_memories USING btree (user_id, type);


--
-- Name: ix_user_snippets_user_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_user_snippets_user_cat ON public.user_snippets USING btree (user_id, category);


--
-- Name: ix_users_feishu_union_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_users_feishu_union_id ON public.users USING btree (feishu_union_id) WHERE (feishu_union_id IS NOT NULL);


--
-- Name: ix_video_delivery_tags_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_video_delivery_tags_job_id ON public.video_delivery_tags USING btree (job_id);


--
-- Name: ix_video_delivery_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_video_delivery_tags_tag ON public.video_delivery_tags USING btree (tag);


--
-- Name: ix_video_download_logs_job_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_video_download_logs_job_id ON public.video_download_logs USING btree (job_id);


--
-- Name: ix_video_download_logs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_video_download_logs_user_id ON public.video_download_logs USING btree (user_id);


--
-- Name: ix_video_prompts_chapter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_video_prompts_chapter ON public.script_video_prompts USING btree (draft_id, chapter_order);


--
-- Name: ix_video_prompts_draft; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_video_prompts_draft ON public.script_video_prompts USING btree (draft_id);


--
-- Name: ix_volc_usage_records_attr_src; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_attr_src ON public.volc_usage_records USING btree (attribution_source);


--
-- Name: ix_volc_usage_records_biz_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_biz_type ON public.volc_usage_records USING btree (biz_type);


--
-- Name: ix_volc_usage_records_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_created_at ON public.volc_usage_records USING btree (created_at);


--
-- Name: ix_volc_usage_records_draft_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_draft_id ON public.volc_usage_records USING btree (draft_id);


--
-- Name: ix_volc_usage_records_model_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_model_key ON public.volc_usage_records USING btree (model_key);


--
-- Name: ix_volc_usage_records_request_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_request_id ON public.volc_usage_records USING btree (request_id);


--
-- Name: ix_volc_usage_records_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_source ON public.volc_usage_records USING btree (source);


--
-- Name: ix_volc_usage_records_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_volc_usage_records_user_id ON public.volc_usage_records USING btree (user_id);


--
-- Name: users_login_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_login_id_key ON public.users USING btree (login_id);


--
-- Name: agent_artifacts agent_artifacts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_artifacts
    ADD CONSTRAINT agent_artifacts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(id) ON DELETE CASCADE;


--
-- Name: agent_artifacts agent_artifacts_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_artifacts
    ADD CONSTRAINT agent_artifacts_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.agent_messages(id) ON DELETE CASCADE;


--
-- Name: agent_attachments agent_attachments_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_attachments
    ADD CONSTRAINT agent_attachments_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(id) ON DELETE CASCADE;


--
-- Name: agent_attachments agent_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_attachments
    ADD CONSTRAINT agent_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.agent_messages(id) ON DELETE CASCADE;


--
-- Name: agent_document_chapters agent_document_chapters_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_document_chapters
    ADD CONSTRAINT agent_document_chapters_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.agent_documents(id) ON DELETE CASCADE;


--
-- Name: agent_documents agent_documents_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_documents
    ADD CONSTRAINT agent_documents_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(id) ON DELETE CASCADE;


--
-- Name: agent_images agent_images_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_images
    ADD CONSTRAINT agent_images_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(id) ON DELETE CASCADE;


--
-- Name: agent_images agent_images_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_images
    ADD CONSTRAINT agent_images_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.agent_messages(id) ON DELETE SET NULL;


--
-- Name: agent_operations agent_operations_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_operations
    ADD CONSTRAINT agent_operations_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.agent_conversations(id);


--
-- Name: agent_operations agent_operations_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_operations
    ADD CONSTRAINT agent_operations_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.agent_messages(id);


--
-- Name: agent_operations agent_operations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_operations
    ADD CONSTRAINT agent_operations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: announcements announcements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: api_usage_logs api_usage_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_usage_logs
    ADD CONSTRAINT api_usage_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: audio_assets audio_assets_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audio_assets
    ADD CONSTRAINT audio_assets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.audio_jobs(id);


--
-- Name: character_consistency_warnings character_consistency_warnings_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_consistency_warnings
    ADD CONSTRAINT character_consistency_warnings_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_consistency_warnings character_consistency_warnings_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_consistency_warnings
    ADD CONSTRAINT character_consistency_warnings_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: character_relationships character_relationships_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_relationships
    ADD CONSTRAINT character_relationships_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: character_relationships character_relationships_from_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_relationships
    ADD CONSTRAINT character_relationships_from_character_id_fkey FOREIGN KEY (from_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: character_relationships character_relationships_to_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.character_relationships
    ADD CONSTRAINT character_relationships_to_character_id_fkey FOREIGN KEY (to_character_id) REFERENCES public.characters(id) ON DELETE CASCADE;


--
-- Name: characters characters_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.characters
    ADD CONSTRAINT characters_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: content_history content_history_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_history
    ADD CONSTRAINT content_history_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: content_history content_history_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_history
    ADD CONSTRAINT content_history_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: critique_issues critique_issues_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.critique_issues
    ADD CONSTRAINT critique_issues_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.critique_runs(id);


--
-- Name: draft_batch_jobs draft_batch_jobs_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_batch_jobs
    ADD CONSTRAINT draft_batch_jobs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: draft_batch_logs draft_batch_logs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_batch_logs
    ADD CONSTRAINT draft_batch_logs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.draft_batch_jobs(id) ON DELETE CASCADE;


--
-- Name: draft_character_images draft_character_images_character_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_character_images
    ADD CONSTRAINT draft_character_images_character_id_fkey FOREIGN KEY (character_id) REFERENCES public.draft_characters(id);


--
-- Name: draft_extend_configs draft_extend_configs_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_extend_configs
    ADD CONSTRAINT draft_extend_configs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: draft_read_state draft_read_state_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_read_state
    ADD CONSTRAINT draft_read_state_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: draft_read_state draft_read_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_read_state
    ADD CONSTRAINT draft_read_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: draft_tags draft_tags_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_tags
    ADD CONSTRAINT draft_tags_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: draft_tags draft_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.draft_tags
    ADD CONSTRAINT draft_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: export_jobs export_jobs_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.export_jobs
    ADD CONSTRAINT export_jobs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: generation_logs generation_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generation_logs
    ADD CONSTRAINT generation_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: image_assets image_assets_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_assets
    ADD CONSTRAINT image_assets_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.image_jobs(id);


--
-- Name: image_billing image_billing_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_billing
    ADD CONSTRAINT image_billing_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.image_jobs(id);


--
-- Name: image_jobs image_jobs_parent_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_jobs
    ADD CONSTRAINT image_jobs_parent_job_id_fkey FOREIGN KEY (parent_job_id) REFERENCES public.image_jobs(id);


--
-- Name: novel_video_audio_chunks novel_video_audio_chunks_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_audio_chunks
    ADD CONSTRAINT novel_video_audio_chunks_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.novel_video_jobs(id) ON DELETE CASCADE;


--
-- Name: novel_video_shots novel_video_shots_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.novel_video_shots
    ADD CONSTRAINT novel_video_shots_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.novel_video_jobs(id) ON DELETE CASCADE;


--
-- Name: outline_candidates outline_candidates_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outline_candidates
    ADD CONSTRAINT outline_candidates_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: preset_backgrounds preset_backgrounds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preset_backgrounds
    ADD CONSTRAINT preset_backgrounds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: project_series project_series_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_series
    ADD CONSTRAINT project_series_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: safety_reports safety_reports_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_reports
    ADD CONSTRAINT safety_reports_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: safety_risks safety_risks_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.safety_risks
    ADD CONSTRAINT safety_risks_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.safety_reports(id) ON DELETE CASCADE;


--
-- Name: script_drafts script_drafts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_drafts
    ADD CONSTRAINT script_drafts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: script_video_prompts script_video_prompts_draft_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.script_video_prompts
    ADD CONSTRAINT script_video_prompts_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES public.script_drafts(id) ON DELETE CASCADE;


--
-- Name: snippets snippets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snippets
    ADD CONSTRAINT snippets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: system_settings system_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: tags tags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: upload_sessions upload_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.upload_sessions
    ADD CONSTRAINT upload_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_audit_logs user_audit_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_audit_logs
    ADD CONSTRAINT user_audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_memories user_memories_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_memories
    ADD CONSTRAINT user_memories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_profiles user_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_profiles
    ADD CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: user_snippets user_snippets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_snippets
    ADD CONSTRAINT user_snippets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: worlds worlds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worlds
    ADD CONSTRAINT worlds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

