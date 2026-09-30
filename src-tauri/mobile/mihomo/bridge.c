#include <jni.h>
#include <pthread.h>
#include <string.h>
#include "bridge.h"
#include "_cgo_export.h"

static JavaVM *vm;
static jobject service;
static jobject probe_network;
static jmethodID probe_protect;
static jmethodID protect_method, package_method;
static pthread_mutex_t callback_lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_key_t thread_attachment;
static pthread_once_t attachment_once = PTHREAD_ONCE_INIT;
static int attachment_ready;

// Go reuses native worker threads. Keep a daemon attachment per native thread,
// releasing it on thread exit instead of creating two Java threads per flow.
// Java-owned threads are never registered here and are never detached by us.
static void detach_native_thread(void *value) {
    JavaVM *owner = (JavaVM *)value;
    if (owner) (*owner)->DetachCurrentThread(owner);
}
static void create_attachment_key(void) {
    attachment_ready = pthread_key_create(&thread_attachment, detach_native_thread) == 0;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *value, void *reserved) {
    vm = value;
    return JNI_VERSION_1_6;
}

static JNIEnv *env_for_thread(void) {
    JNIEnv *env = NULL;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) == JNI_EDETACHED) {
        pthread_once(&attachment_once, create_attachment_key);
        if (!attachment_ready || (*vm)->AttachCurrentThreadAsDaemon(vm, &env, NULL) != JNI_OK) return NULL;
        if (pthread_setspecific(thread_attachment, vm) != 0) { (*vm)->DetachCurrentThread(vm); return NULL; }
    }
    return env;
}

int pw_protect(int fd, int allow_probe_network) {
    int ok = 0;
    JNIEnv *env = env_for_thread();
    if (!env) return 0;
    pthread_mutex_lock(&callback_lock);
    jobject callback = service ? (*env)->NewLocalRef(env, service) : (allow_probe_network && probe_network ? (*env)->NewLocalRef(env, probe_network) : NULL);
    jmethodID method = service ? protect_method : probe_protect;
    pthread_mutex_unlock(&callback_lock);
    if (callback) { ok = (*env)->CallBooleanMethod(env, callback, method, fd); (*env)->DeleteLocalRef(env, callback); }
    if ((*env)->ExceptionCheck(env)) { (*env)->ExceptionClear(env); ok = 0; }
    return ok;
}

char *pw_package(int protocol, const char *src, int sport, const char *dst, int dport) {
    JNIEnv *env = env_for_thread();
    if (!env) return strdup("");
    char *answer = NULL;
    if ((*env)->PushLocalFrame(env, 8) == JNI_OK) {
        pthread_mutex_lock(&callback_lock);
        jobject callback = service ? (*env)->NewLocalRef(env, service) : NULL;
        jmethodID method = package_method;
        pthread_mutex_unlock(&callback_lock);
        if (callback) {
        jstring source = (*env)->NewStringUTF(env, src), dest = (*env)->NewStringUTF(env, dst);
        jstring result = (*env)->CallObjectMethod(env, callback, method, protocol, source, sport, dest, dport);
        if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
        else if (result) {
            const char *text = (*env)->GetStringUTFChars(env, result, NULL);
            if (text) { answer = strdup(text); (*env)->ReleaseStringUTFChars(env, result, text); }
        }
        }
        (*env)->PopLocalFrame(env, NULL);
    }
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    return answer ? answer : strdup("");
}

static jstring result_string(JNIEnv *env, char *result) {
    jstring value = (*env)->NewStringUTF(env, result ? result : "native result missing");
    free(result);
    return value;
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_health(JNIEnv *env, jobject self, jstring home, jstring args, jobject network) {
    pthread_mutex_lock(&callback_lock);
    if (!probe_network && network) {
        jclass type = (*env)->GetObjectClass(env, network);
        probe_protect = type ? (*env)->GetMethodID(env, type, "protectSocket", "(I)Z") : NULL;
        if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
        if (probe_protect) probe_network = (*env)->NewGlobalRef(env, network);
        if (type) (*env)->DeleteLocalRef(env, type);
    }
    pthread_mutex_unlock(&callback_lock);
    const char *h = (*env)->GetStringUTFChars(env, home, NULL);
    const char *a = (*env)->GetStringUTFChars(env, args, NULL);
    if (!h || !a) { if (h) (*env)->ReleaseStringUTFChars(env, home, h); if (a) (*env)->ReleaseStringUTFChars(env, args, a); return NULL; }
    char *result = PWHealth((char *)h, (char *)a);
    (*env)->ReleaseStringUTFChars(env, home, h);
    (*env)->ReleaseStringUTFChars(env, args, a);
    return result_string(env, result);
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_validate(JNIEnv *env, jobject self, jstring home, jstring config) {
    const char *h = (*env)->GetStringUTFChars(env, home, NULL);
    const char *c = (*env)->GetStringUTFChars(env, config, NULL);
    char *result = PWValidate((char *)h, (char *)c);
    (*env)->ReleaseStringUTFChars(env, home, h);
    (*env)->ReleaseStringUTFChars(env, config, c);
    return result_string(env, result);
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_start(JNIEnv *env, jobject self, jstring home, jstring config, jint fd, jobject callbacks) {
    pthread_mutex_lock(&callback_lock);
    if (service) { pthread_mutex_unlock(&callback_lock); return (*env)->NewStringUTF(env, "core already started"); }
    if (!callbacks) { pthread_mutex_unlock(&callback_lock); return (*env)->NewStringUTF(env, "missing VPN callbacks"); }
    service = (*env)->NewGlobalRef(env, callbacks);
    jclass type = (*env)->GetObjectClass(env, callbacks);
    protect_method = type ? (*env)->GetMethodID(env, type, "protectSocket", "(I)Z") : NULL;
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    package_method = type ? (*env)->GetMethodID(env, type, "connectionPackage", "(ILjava/lang/String;ILjava/lang/String;I)Ljava/lang/String;") : NULL;
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    if (type) (*env)->DeleteLocalRef(env, type);
    if (!service || !protect_method || !package_method) {
        if (service) (*env)->DeleteGlobalRef(env, service);
        service = NULL;
        pthread_mutex_unlock(&callback_lock);
        return (*env)->NewStringUTF(env, "VPN callback methods unavailable");
    }
    pthread_mutex_unlock(&callback_lock);
    const char *h = (*env)->GetStringUTFChars(env, home, NULL);
    const char *c = (*env)->GetStringUTFChars(env, config, NULL);
    char *result = PWStart((char *)h, (char *)c, fd);
    (*env)->ReleaseStringUTFChars(env, home, h);
    (*env)->ReleaseStringUTFChars(env, config, c);
    return result_string(env, result);
}

JNIEXPORT void JNICALL Java_com_procweaver_mobile_NativeCore_stop(JNIEnv *env, jobject self) {
    PWStop();
    pthread_mutex_lock(&callback_lock);
    if (service) { (*env)->DeleteGlobalRef(env, service); service = NULL; }
    pthread_mutex_unlock(&callback_lock);
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_reload(JNIEnv *env, jobject self, jstring config) {
    const char *raw = (*env)->GetStringUTFChars(env, config, NULL);
    char *result = PWReload((char *)raw);
    (*env)->ReleaseStringUTFChars(env, config, raw);
    return result_string(env, result);
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_mode(JNIEnv *env, jobject self, jstring mode) {
    const char *raw = (*env)->GetStringUTFChars(env, mode, NULL);
    char *result = PWMode((char *)raw);
    (*env)->ReleaseStringUTFChars(env, mode, raw);
    return result_string(env, result);
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_stats(JNIEnv *env, jobject self) {
    return result_string(env, PWStats());
}

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_validateGeo(JNIEnv *env, jobject self, jstring kind, jstring path) {
    const char *k = (*env)->GetStringUTFChars(env, kind, NULL);
    const char *p = (*env)->GetStringUTFChars(env, path, NULL);
    if (!k || !p) { if (k) (*env)->ReleaseStringUTFChars(env, kind, k); if (p) (*env)->ReleaseStringUTFChars(env, path, p); return NULL; }
    char *result = PWValidateGeo((char *)k, (char *)p);
    (*env)->ReleaseStringUTFChars(env, kind, k);
    (*env)->ReleaseStringUTFChars(env, path, p);
    return result_string(env, result);
}

JNIEXPORT void JNICALL Java_com_procweaver_mobile_NativeCore_networkChanged(JNIEnv *env, jobject self) { PWNetworkChanged(); }

JNIEXPORT jstring JNICALL Java_com_procweaver_mobile_NativeCore_history(JNIEnv *env, jobject self, jstring home, jstring zone, jstring action, jlong start, jlong end) {
    const char *h = (*env)->GetStringUTFChars(env, home, NULL);
    const char *z = (*env)->GetStringUTFChars(env, zone, NULL);
    const char *a = (*env)->GetStringUTFChars(env, action, NULL);
    if (!h || !z || !a) {
        if (h) (*env)->ReleaseStringUTFChars(env, home, h);
        if (z) (*env)->ReleaseStringUTFChars(env, zone, z);
        if (a) (*env)->ReleaseStringUTFChars(env, action, a);
        return NULL;
    }
    char *result = PWHistory((char *)h, (char *)z, (char *)a, start, end);
    (*env)->ReleaseStringUTFChars(env, home, h);
    (*env)->ReleaseStringUTFChars(env, zone, z);
    (*env)->ReleaseStringUTFChars(env, action, a);
    return result_string(env, result);
}
