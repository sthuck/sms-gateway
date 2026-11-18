package com.sthuck.smsgateway.crypto

import com.sthuck.smsgateway.data.remote.RequestSigningInterceptor
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path
import java.security.KeyFactory
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * Verifies the Android signing helpers against
 * `docs/contracts/examples/test-vector.json` (primary + `devHostVector`).
 *
 * ECDSA is non-deterministic: assert verification, not byte equality with
 * the frozen signature (except as a known-good verify vector).
 */
class SigningContractTest {

    private lateinit var vector: JsonObject
    private lateinit var privateKey: PrivateKey
    private lateinit var publicKey: PublicKey

    @Before
    fun setUp() {
        val text = Files.readString(locateTestVector())
        vector = Json.parseToJsonElement(text).jsonObject
        privateKey = loadPkcs8(vector["testPrivateKeyPkcs8Pem"]!!.jsonPrimitive.content)
        publicKey = loadSpki(vector["testPublicKeySpkiPem"]!!.jsonPrimitive.content)
    }

    @Test
    fun publicKeySpkiMatchesVector() {
        assertEquals(
            vector["testPublicKeySpkiB64url"]!!.jsonPrimitive.content,
            Base64Url.encode(publicKey.encoded),
        )
    }

    @Test
    fun emptyBodySha256MatchesContract() {
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            RequestSigningInterceptor.sha256Hex(ByteArray(0)),
        )
    }

    @Test
    fun parseHttpDateToUnixSeconds() {
        assertEquals(
            1_794_995_160L,
            RequestSigningInterceptor.parseHttpDateToUnixSeconds(
                "Wed, 18 Nov 2026 09:46:00 GMT",
            ),
        )
    }

    @Test
    fun primaryVectorBodyHashCanonicalAndFrozenSignature() {
        assertVector(vector, label = "primary")
    }

    @Test
    fun devHostVectorKeepsPortInHost() {
        val dev = vector["devHostVector"]!!.jsonObject
        assertVector(dev, label = "devHostVector")
        val canonical = dev["canonicalString"]!!.jsonPrimitive.content
        assertTrue(canonical.contains("\n10.0.2.2:4010\n"))
        assertEquals(
            "10.0.2.2:4010",
            dev["request"]!!.jsonObject["headers"]!!.jsonObject["Host"]!!.jsonPrimitive.content,
        )
    }

    private fun assertVector(root: JsonObject, label: String) {
        val request = root["request"]!!.jsonObject
        val headers = request["headers"]!!.jsonObject
        val body = request["body"]!!.jsonPrimitive.content
        val bodyBytes = body.toByteArray(Charsets.UTF_8)

        assertEquals(
            "bodyUtf8ByteLength ($label)",
            request["bodyUtf8ByteLength"]!!.jsonPrimitive.content.toInt(),
            bodyBytes.size,
        )
        assertEquals(
            "bodySha256Hex ($label)",
            root["bodySha256Hex"]!!.jsonPrimitive.content,
            RequestSigningInterceptor.sha256Hex(bodyBytes),
        )

        val canonical = CanonicalString.build(
            method = request["method"]!!.jsonPrimitive.content,
            path = request["path"]!!.jsonPrimitive.content,
            query = request["query"]!!.jsonPrimitive.content,
            host = headers["Host"]!!.jsonPrimitive.content,
            deviceId = headers["X-Device-Id"]!!.jsonPrimitive.content,
            timestamp = headers["X-Timestamp"]!!.jsonPrimitive.content,
            contentSha256 = headers["X-Content-SHA256"]!!.jsonPrimitive.content,
            nonce = headers["X-Nonce"]!!.jsonPrimitive.content,
        )
        assertEquals("canonicalString ($label)", root["canonicalString"]!!.jsonPrimitive.content, canonical)

        val frozen = Base64Url.decode(root["frozenSignatureB64url"]!!.jsonPrimitive.content)
        val canonicalBytes = canonical.toByteArray(Charsets.UTF_8)
        assertTrue(
            "frozen signature must verify ($label)",
            verifyEs256P1363(publicKey, canonicalBytes, frozen),
        )

        val fresh = PrivateKeyDeviceSigner(privateKey).sign(canonicalBytes)
        assertTrue(
            "fresh signature must verify ($label)",
            verifyEs256P1363(publicKey, canonicalBytes, fresh),
        )
        assertEquals(
            "fresh signature encoding ($label)",
            Base64Url.encode(fresh),
            Base64Url.encode(fresh).trimEnd('='),
        )
        assertFalse(
            "fresh signature must not contain base64 padding ($label)",
            Base64Url.encode(fresh).contains('='),
        )

        val tampered = canonical.replaceFirst("v1", "v2").toByteArray(Charsets.UTF_8)
        assertFalse(
            "tampered canonical must be rejected ($label)",
            verifyEs256P1363(publicKey, tampered, frozen),
        )
    }

    private fun loadPkcs8(pem: String): PrivateKey {
        val der = Base64.getDecoder().decode(stripPem(pem))
        return KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(der))
    }

    private fun loadSpki(pem: String): PublicKey {
        val der = Base64.getDecoder().decode(stripPem(pem))
        return KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(der))
    }

    private fun stripPem(pem: String): String =
        pem.lineSequence()
            .filterNot { it.startsWith("-----") }
            .joinToString("")
            .replace("\\s".toRegex(), "")

    companion object {
        fun locateTestVector(): Path {
            val candidates = listOf(
                Path.of("docs/contracts/examples/test-vector.json"),
                Path.of("../docs/contracts/examples/test-vector.json"),
                Path.of("../../docs/contracts/examples/test-vector.json"),
                Path.of("../../../docs/contracts/examples/test-vector.json"),
            )
            return candidates.firstOrNull { Files.isRegularFile(it) }
                ?: error(
                    "test-vector.json not found from ${Path.of("").toAbsolutePath()} " +
                        "(tried $candidates)",
                )
        }
    }
}
