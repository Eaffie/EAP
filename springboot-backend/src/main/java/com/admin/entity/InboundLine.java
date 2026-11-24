package com.admin.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import lombok.Data;

import java.io.Serializable;

/**
 * <p>
 * 线路 = 车友 × 机器 × 落地组;直连(landing_id 空)再按【入站】细分。
 * landing_id 非空=该落地的中转线路(inbound_id 恒为空,一条中转 = 该落地下全部协议);
 * landing_id 空=直连线路,此时 inbound_id 指向具体那一条直连入站 —— 每条直连入站
 * 各算一条线路:各一条订阅、各一份流量/到期配额、各自的线路级限速。
 * 已用流量不存这里,实时汇总该线路各协议对应转发的 in_flow+out_flow。
 * </p>
 *
 * @since 2026-07-26
 */
@Data
public class InboundLine implements Serializable {

    private static final long serialVersionUID = 1L;

    @TableId(value = "id", type = IdType.AUTO)
    private Long id;

    /** 车友 */
    private Long userId;

    /** 机器 */
    private Long nodeId;

    /** 落地ID:空=直连线路(此时由 inboundId 区分是哪条入站) */
    private Long landingId;

    /**
     * 直连线路所属入站(landing_id 为空时用)。
     * 中转恒为空 —— 一条中转线路本来就是该落地的全部协议合起来一条。
     * 老库里的直连线路这一列为空,启动时由 SchemaMigration 按入站补开。
     */
    private Long inboundId;

    /** 该线路的订阅 token */
    private String subToken;

    /** 该线路流量配额(GB);0/null=不单独限,只受账号总流量约束 */
    private Long flow;

    /** 该线路到期时间(epoch ms);空=不单独限 */
    private Long expTime;

    /** 1=正常 0=已停(超额/到期) */
    private Integer status;

    private Long createdTime;

    private Long updatedTime;
}
