package muse.hongguo.v2;

import com.hongguo.core.FetchGate;
import com.hongguo.desktop.ui.AppController;
import com.hongguo.desktop.ui.QueueManager;
import com.hongguo.helper.Messages;
import com.hongguo.helper.Method;
import com.hongguo.helper.Methods;
import com.hongguo.helper.Protocol;
import com.hongguo.helper.RpcError;
import com.hongguo.helper.Server;
import com.hongguo.helper.engine.DownloadsApi;
import com.hongguo.helper.engine.QueueStore;
import com.hongguo.helper.engine.SavedQueue;
import com.hongguo.helper.engine.SeriesApi;
import com.hongguo.helper.engine.SettingsApi;
import com.hongguo.helper.licence.Licence;
import com.hongguo.helper.licence.LicenceSelfTest;
import com.hongguo.helper.licence.PinnedKeys;
import com.hongguo.helper.licence.ProofVerifier;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.LinkOption;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Locale;
import java.util.Set;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import kotlin.Unit;
import kotlin.jvm.functions.Function2;
import kotlinx.serialization.json.Json;
import kotlinx.serialization.json.JsonArray;
import kotlinx.serialization.json.JsonPrimitive;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;

/** Locally configured host using the original verifier, licence gate and job API. */
public final class PortableHost {
    private final Config config;
    private final Function2<String, JsonElement, Unit> notifications;
    private final Licence licence;
    private AppController app;
    private SeriesApi series;
    private DownloadsApi downloads;
    private boolean stopping;

    private PortableHost(Config config, Protocol protocol) {
        this.config = config;
        notifications = (method, params) -> {
            protocol.send(Messages.INSTANCE.notification(method, params));
            return Unit.INSTANCE;
        };
        licence = new Licence(
                new ProofVerifier(PinnedKeys.INSTANCE.getV2(), 15L),
                () -> config.deviceId,
                notifications,
                message -> Unit.INSTANCE,
                System::nanoTime,
                System::currentTimeMillis,
                true);
    }

    /** Runs the original line protocol with an explicit, private host configuration. */
    public static void main(String[] args) throws IOException {
        if (args.length != 1) throw new IllegalArgumentException("Expected one private configuration path");
        Config config = Config.read(Path.of(args[0]));
        Protocol protocol = new Protocol(new FileOutputStream(FileDescriptor.out));
        System.setOut(System.err);
        String failure = LicenceSelfTest.INSTANCE.run();
        if (failure != null) {
            System.err.println("Portable host licence self-test failed");
            System.exit(3);
            return;
        }
        PortableHost host = new PortableHost(config, protocol);
        Runtime.getRuntime().addShutdownHook(new Thread(host::shutdown, "portable-host-shutdown"));
        new Server(protocol, new Methods(host.methods(), () -> {
            host.shutdown();
            return Unit.INSTANCE;
        })).run(new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)));
    }

    private List<Method> methods() {
        List<Method> methods = new ArrayList<>();
        methods.add(sync("license.status", "license.v1", licence::status));
        methods.add(sync("license.challenge", "license.v1", licence::challenge));
        methods.add(sync("license.prove", "license.v1", licence::prove));
        methods.add(sync("license.restore", "license.v1", licence::restore));
        methods.add(sync("license.set", "license.v1", licence::set));
        methods.add(sync("license.clear", "license.v1", licence::clear));
        methods.add(new Method("series.detail", "series.detail", false,
                (params, continuation) -> series().detail(params, continuation)));
        methods.add(sync("downloads.add", "downloads.add", params -> {
            validateRequestedEpisodes(params);
            return downloads().add(params);
        }));
        methods.add(sync("downloads.snapshot", "downloads.snapshot", params -> downloads().snapshot(params)));
        methods.add(sync("downloads.cancelAll", "downloads.cancelAll", params -> downloads().cancelAll(params)));
        return methods;
    }

    private static Method sync(String name, String capability, SyncMethod handler) {
        return new Method(name, capability, false, (params, continuation) -> handler.run(params));
    }

    private synchronized AppController app() {
        if (stopping) throw propagate(new RpcError(-32000, "Host is stopping", null));
        if (app == null) {
            // The original SDK owns its media guest strategy. The host never rotates it after failure.
            AppController next = new AppController((FetchGate) licence,
                    file -> config.networkStorage, QueueManager.Companion.getSeriesTimesEpisodes());
            try {
                Map<String, JsonElement> patch = new LinkedHashMap<>();
                patch.put("saveFolder", JsonElementKt.JsonPrimitive(config.outputRoot.toString()));
                patch.put("seriesAtOnce", JsonElementKt.JsonPrimitive(config.seriesAtOnce));
                patch.put("episodesAtOnce", JsonElementKt.JsonPrimitive(config.episodesAtOnce));
                patch.put("connectionsPerFile", JsonElementKt.JsonPrimitive(config.connectionsPerFile));
                patch.put("quality", JsonElementKt.JsonPrimitive(config.quality));
                patch.put("overwrite", JsonElementKt.JsonPrimitive(false));
                patch.put("merge", JsonElementKt.JsonPrimitive(false));
                patch.put("deleteAfterMerge", JsonElementKt.JsonPrimitive(false));
                new SettingsApi(next).update(new JsonObject(Map.of("patch", new JsonObject(patch))));
            } catch (RuntimeException error) {
                next.shutdown();
                throw error;
            }
            app = next;
        }
        return app;
    }

    private synchronized SeriesApi series() {
        if (series == null) series = new SeriesApi(app());
        return series;
    }

    private synchronized DownloadsApi downloads() {
        if (downloads == null) {
            // A new private run must not silently resume a prior SDK queue.
            try {
                Files.createFile(config.queueFile);
            } catch (IOException error) {
                throw propagate(new RpcError(-32000, "Queue file already exists or cannot be reserved", null));
            }
            downloads = new DownloadsApi(app(), notifications,
                    new SavedQueue(true, List.of()), new QueueStore(config.queueFile.toFile()), licence);
        }
        return downloads;
    }

    private void validateRequestedEpisodes(JsonObject params) {
        JsonElement requestsValue = params == null ? null : params.get("requests");
        if (!(requestsValue instanceof JsonArray requests) || requests.size() != 1) {
            throw propagate(new RpcError(-32602, "This private host accepts exactly one explicit request per call", null));
        }
        if (!(requests.get(0) instanceof JsonObject request)
                || !(request.get("episodes") instanceof JsonArray episodes)
                || episodes.isEmpty() || episodes.size() > config.maxEpisodesPerJob) {
            throw propagate(new RpcError(-32602, "Explicit episodes must fit the configured job limit", null));
        }
    }

    /** Preserve the original Kotlin RPC exception across Java's checked-exception typing. */
    @SuppressWarnings("unchecked")
    private static <E extends Throwable> RuntimeException propagate(Throwable error) throws E {
        throw (E) error;
    }

    private synchronized void shutdown() {
        if (stopping) return;
        stopping = true;
        try {
            if (downloads != null) downloads.prepareShutdown();
        } finally {
            if (app != null) app.shutdown();
        }
    }

    @FunctionalInterface
    private interface SyncMethod {
        JsonElement run(JsonObject params);
    }

    private static final class Config {
        final String deviceId;
        final Path outputRoot;
        final Path queueFile;
        final int seriesAtOnce;
        final int episodesAtOnce;
        final int connectionsPerFile;
        final int maxEpisodesPerJob;
        final String quality;
        final boolean networkStorage;

        private Config(Properties values) throws IOException {
            deviceId = deviceIdentity(absolute(values, "deviceFile"));
            Path privateRoot = absolute(values, "privateRoot").toRealPath();
            outputRoot = contained(privateRoot, absolute(values, "outputRoot"));
            queueFile = contained(privateRoot, absolute(values, "queueFile"));
            Path home = contained(privateRoot, absolute(values, "userHome"));
            Path appData = contained(privateRoot, absolute(values, "appData"));
            Path temporary = contained(privateRoot, absolute(values, "tempDir"));
            if (!home.equals(Path.of(System.getProperty("user.home")).toAbsolutePath().normalize())
                    || !temporary.equals(Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().normalize())
                    || !appData.toString().equals(System.getenv("APPDATA"))) {
                throw new IllegalArgumentException("Process directories do not match private configuration");
            }
            if (!absolute(values, "signerDir").toRealPath().equals(Path.of(System.getProperty("hongguo.signer.dir")).toRealPath())
                    || !absolute(values, "ffmpeg").toRealPath().equals(Path.of(System.getProperty("hongguo.ffmpeg")).toRealPath())) {
                throw new IllegalArgumentException("Runtime resources do not match private configuration");
            }
            if (!Files.isDirectory(outputRoot) || !Files.isDirectory(queueFile.getParent())) {
                throw new IllegalArgumentException("Private output and queue parent must already exist");
            }
            seriesAtOnce = positive(values, "seriesAtOnce", 1);
            episodesAtOnce = positive(values, "episodesAtOnce", 8);
            connectionsPerFile = positive(values, "connectionsPerFile", 4);
            maxEpisodesPerJob = positive(values, "maxEpisodesPerJob", 10000);
            quality = required(values, "quality");
            if (!List.of("1080p", "720p", "540p", "480p", "360p").contains(quality)) throw new IllegalArgumentException("Unknown quality");
            String network = required(values, "networkStorage");
            if (!network.equals("true") && !network.equals("false")) throw new IllegalArgumentException("Invalid networkStorage flag");
            networkStorage = Boolean.parseBoolean(network);
        }

        private static String deviceIdentity(Path path) throws IOException {
            if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) || !path.toRealPath().equals(path)) {
                throw new IllegalArgumentException("Private device record must be a regular unlinked file");
            }
            String os = System.getProperty("os.name").toLowerCase(Locale.ROOT);
            String platform = os.startsWith("windows") ? "win32" : os.contains("mac") || os.equals("darwin") ? "darwin" : "unsupported";
            if (platform.equals("unsupported")) throw new IllegalArgumentException("Unsupported host platform");
            if (!platform.equals("win32") && !Files.getPosixFilePermissions(path).equals(Set.of(
                    PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE))) {
                throw new IllegalArgumentException("Private device record requires owner-only permissions");
            }
            JsonElement parsed = Json.Default.parseToJsonElement(Files.readString(path, StandardCharsets.UTF_8));
            if (!(parsed instanceof JsonObject record) || record.size() != 3
                    || !text(record, "version").equals("1") || !text(record, "platform").equals(platform)) {
                throw new IllegalArgumentException("Invalid private device record");
            }
            String id = text(record, "deviceId");
            if (!id.matches("d1:[0-9a-f]{32}")) throw new IllegalArgumentException("Invalid host device identity format");
            return id;
        }

        private static String text(JsonObject record, String name) {
            JsonElement value = record.get(name);
            return value instanceof JsonPrimitive primitive ? primitive.getContent() : "";
        }

        static Config read(Path path) throws IOException {
            Properties values = new Properties();
            try (Reader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) { values.load(reader); }
            return new Config(values);
        }

        static String required(Properties values, String name) {
            String value = values.getProperty(name);
            if (value == null || value.isBlank()) throw new IllegalArgumentException("Missing private configuration field: " + name);
            return value;
        }

        static Path absolute(Properties values, String name) {
            Path value = Path.of(required(values, name));
            if (!value.isAbsolute()) throw new IllegalArgumentException("Configuration path must be absolute: " + name);
            return value.normalize();
        }

        static Path contained(Path root, Path value) throws IOException {
            if (!value.startsWith(root)) throw new IllegalArgumentException("State path escapes private root");
            Path existing = value;
            while (!Files.exists(existing)) existing = existing.getParent();
            if (!existing.toRealPath().startsWith(root)) throw new IllegalArgumentException("State path resolves outside private root");
            return value;
        }

        static int positive(Properties values, String name, int maximum) {
            int value = Integer.parseInt(required(values, name));
            if (value < 1 || value > maximum) throw new IllegalArgumentException("Configuration limit out of range: " + name);
            return value;
        }
    }
}
